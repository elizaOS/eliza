use std::{str::FromStr, sync::Arc};
use solana_program_pack::Pack;
use anchor_client::solana_client::rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig};
use anchor_client::solana_client::rpc_filter::{Memcmp, MemcmpEncodedBytes, RpcFilterType};
use anchor_client::solana_client::rpc_request::TokenAccountsFilter;
use solana_account_decoder::UiAccountEncoding;
use anyhow::{anyhow, Result};
use colored::Colorize;
use anchor_client::solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::Keypair,
    system_instruction,
    system_program,
    signer::Signer,
};
use crate::engine::transaction_parser::DexType;
use spl_associated_token_account::{
    get_associated_token_address,
    get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent
};
use spl_token::instruction::sync_native;
use spl_token::ui_amount_to_amount;
use tokio::sync::OnceCell;
use lru::LruCache;
use std::num::NonZeroUsize;

use crate::{
    common::{config::SwapConfig, logger::Logger, cache::WALLET_TOKEN_ACCOUNTS},
    core::token,
    engine::swap::{SwapDirection, SwapInType},
};

use crate::dex::pump_fun::PUMP_BUYBACK_FEE_RECIPIENTS;

// PUMP SWAP FIXES:
// 1. Fixed buy token amount calculation to use same direct formula as pump fun
// 2. Fixed sell accounts to have reversed user account order (user SOL and token accounts swapped)
//    compared to buy accounts, while keeping pool accounts in same order
// 3. Added clear comments to distinguish buy vs sell account ordering

// Constants - moved to lazy_static for single initialization
lazy_static::lazy_static! {
    static ref TOKEN_PROGRAM: Pubkey = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap();
    static ref TOKEN_2022_PROGRAM: Pubkey = Pubkey::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap();
    static ref ASSOCIATED_TOKEN_PROGRAM: Pubkey = Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap();
    static ref PUMP_SWAP_PROGRAM: Pubkey = Pubkey::from_str("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA").unwrap();
    static ref PUMP_FEE_PROGRAM: Pubkey = Pubkey::from_str("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ").unwrap();
    static ref PUMP_GLOBAL_CONFIG: Pubkey = Pubkey::from_str("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw").unwrap();
    static ref PUMP_SWAP_FEE_RECIPIENT: Pubkey = Pubkey::from_str("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV").unwrap();
    static ref PUMP_EVENT_AUTHORITY: Pubkey = Pubkey::from_str("GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR").unwrap();
    static ref SOL_MINT: Pubkey = Pubkey::from_str("So11111111111111111111111111111111111111112").unwrap();
    static ref BUY_DISCRIMINATOR: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];
    static ref BUY_EXACT_QUOTE_IN_DISCRIMINATOR: [u8; 8] = [198, 46, 21, 82, 180, 217, 232, 112];
    static ref SELL_DISCRIMINATOR: [u8; 8] = [51, 230, 133, 164, 1, 127, 131, 173];
    static ref DEFAULT_BUYBACK_FEE_RECIPIENT: Pubkey = Pubkey::from_str(PUMP_BUYBACK_FEE_RECIPIENTS[0]).unwrap();
}

// Volume accumulator seed constants
const GLOBAL_VOLUME_ACCUMULATOR_SEED: &[u8] = b"global_volume_accumulator";
const USER_VOLUME_ACCUMULATOR_SEED: &[u8] = b"user_volume_accumulator";
const FEE_CONFIG_SEED: &[u8] = b"fee_config";
const DEFAULT_PUMPSWAP_TOTAL_BUY_FEE_BPS: u64 = 120;
const BUY_BASE_OUT_SAFETY_BPS: u64 = 25;

/// Get the global volume accumulator PDA for PumpSwap
fn get_global_volume_accumulator_pda() -> Result<Pubkey> {
    let seeds = [GLOBAL_VOLUME_ACCUMULATOR_SEED];
    let (pda, _bump) = Pubkey::find_program_address(&seeds, &PUMP_SWAP_PROGRAM);
    Ok(pda)
}

/// Get the user volume accumulator PDA for a specific user for PumpSwap
fn get_user_volume_accumulator_pda(user: &Pubkey) -> Result<Pubkey> {
    let seeds = [USER_VOLUME_ACCUMULATOR_SEED, user.as_ref()];
    let (pda, _bump) = Pubkey::find_program_address(&seeds, &PUMP_SWAP_PROGRAM);
    Ok(pda)
}

fn get_fee_config_pda() -> Pubkey {
    Pubkey::find_program_address(&[FEE_CONFIG_SEED, PUMP_SWAP_PROGRAM.as_ref()], &PUMP_FEE_PROGRAM).0
}

fn get_pool_v2_pda(base_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"pool-v2", base_mint.as_ref()], &PUMP_SWAP_PROGRAM).0
}

// Thread-safe cache with LRU eviction policy
static TOKEN_ACCOUNT_CACHE: OnceCell<LruCache<Pubkey, bool>> = OnceCell::const_new();

const TEN_THOUSAND: u64 = 10000;
const CACHE_SIZE: usize = 1000;

async fn init_caches() {
    TOKEN_ACCOUNT_CACHE.get_or_init(|| async {
        LruCache::new(NonZeroUsize::new(CACHE_SIZE).unwrap())
    }).await;
}

pub struct PumpSwap {
    pub keypair: Arc<Keypair>,
    pub rpc_client: Option<Arc<anchor_client::solana_client::rpc_client::RpcClient>>,
    pub rpc_nonblocking_client: Option<Arc<anchor_client::solana_client::nonblocking::rpc_client::RpcClient>>,
}

impl PumpSwap {
    pub fn new(
        keypair: Arc<Keypair>,
        rpc_client: Option<Arc<anchor_client::solana_client::rpc_client::RpcClient>>,
        rpc_nonblocking_client: Option<Arc<anchor_client::solana_client::nonblocking::rpc_client::RpcClient>>,
    ) -> Self {
        // Initialize caches on first use
        tokio::spawn(init_caches());
        
        Self {
            keypair,
            rpc_client,
            rpc_nonblocking_client,
        }
    }

    pub async fn get_token_price(&self, mint_str: &str) -> Result<f64> {
        // For price calculation, we'll need to make RPC calls since we don't have trade info
        // This is only used for price queries, not for building transactions
        let mint = Pubkey::from_str(mint_str).map_err(|_| anyhow!("Invalid mint address"))?;
        let rpc_client = self.rpc_client.clone()
            .ok_or_else(|| anyhow!("RPC client not initialized"))?;
        
        // For price queries, we need to get current pool state
        let pool_info = get_pool_info_for_price(rpc_client, mint).await?;
        
        // Calculate price using current reserves
        if pool_info.1 == 0 {
            return Ok(0.0);
        }
        
        // Price formula: quote_reserve / base_reserve  
        let price = pool_info.2 as f64 / pool_info.1 as f64;
        Ok(price)
    }

    /// Get basic pool information for selling strategy compatibility
    /// Returns (pool_id, base_mint, quote_mint, base_reserve, quote_reserve)
    pub async fn get_pool_info(&self, mint_str: &str) -> Result<(Pubkey, Pubkey, Pubkey, u64, u64)> {
        let mint = Pubkey::from_str(mint_str).map_err(|_| anyhow!("Invalid mint address"))?;
        let rpc_client = self.rpc_client.clone()
            .ok_or_else(|| anyhow!("RPC client not initialized"))?;
        
        let (pool_id, base_reserve, quote_reserve) = get_pool_info_for_price(rpc_client, mint).await?;
        
        Ok((pool_id, mint, *SOL_MINT, base_reserve, quote_reserve))
    }

    /// Get liquidity (quote reserve) for the pool
    pub async fn get_pool_liquidity(&self, mint_str: &str) -> Result<f64> {
        let (_, _, _, _, quote_reserve) = self.get_pool_info(mint_str).await?;
        Ok(quote_reserve as f64 / 1e9) // Convert lamports to SOL
    }

    pub async fn build_buy_from_mint(
        &self,
        mint: Pubkey,
        amount_sol: f64,
        slippage_bps: u64,
        coin_creator: Pubkey,
    ) -> Result<(Arc<Keypair>, Vec<Instruction>, f64)> {
        let rpc_client = self.rpc_client.clone()
            .ok_or_else(|| anyhow!("RPC client not initialized"))?;
        let (pool_id, base_reserve, quote_reserve) = get_pool_info_for_price(rpc_client, mint).await?;

        let trade_info = crate::engine::transaction_parser::TradeInfoFromToken {
            dex_type: DexType::PumpSwap,
            slot: 0,
            signature: String::new(),
            pool_id: pool_id.to_string(),
            mint: mint.to_string(),
            timestamp: 0,
            is_buy: true,
            price: 0,
            is_reverse_when_pump_swap: false,
            coin_creator: Some(coin_creator.to_string()),
            sol_change: amount_sol,
            token_change: 0.0,
            liquidity: quote_reserve as f64 / 1_000_000_000.0,
            virtual_sol_reserves: quote_reserve,
            virtual_token_reserves: base_reserve,
        };

        self.build_swap_from_parsed_data(
            &trade_info,
            SwapConfig {
                swap_direction: SwapDirection::Buy,
                in_type: SwapInType::Qty,
                amount_in: amount_sol,
                slippage: slippage_bps,
            },
        ).await
    }

    // Highly optimized build_swap_from_parsed_data - now uses only TradeInfoFromToken
    pub async fn build_swap_from_parsed_data(
        &self,
        trade_info: &crate::engine::transaction_parser::TradeInfoFromToken,
        swap_config: SwapConfig,
    ) -> Result<(Arc<Keypair>, Vec<Instruction>, f64)> {
        let logger = Logger::new("[PUMPSWAP-FROM-PARSED] => ".blue().to_string());
        let start_time = std::time::Instant::now();
        
        // Early validation
        if trade_info.dex_type != DexType::PumpSwap {
            return Err(anyhow!("Invalid transaction type"));
        }
        
        let mint = Pubkey::from_str(&trade_info.mint)?;
        let owner = self.keypair.pubkey();
        
        // Extract all needed data from TradeInfoFromToken
        let pool_id = Pubkey::from_str(&trade_info.pool_id)?;
        let coin_creator = if let Some(ref creator_str) = trade_info.coin_creator {
            Pubkey::from_str(creator_str)?
        } else {
            return Err(anyhow!("Coin creator not found in trade info"));
        };
        
        // Use virtual reserves from trade_info for calculations
        let token_price = Self::calculate_price_from_virtual_reserves(
            trade_info.virtual_sol_reserves,
            trade_info.virtual_token_reserves,
        );
        
        logger.log(format!("Using parsed data - Pool: {}, Coin Creator: {}, Virtual SOL: {}, Virtual Tokens: {}, Price: {}", 
            pool_id, coin_creator, trade_info.virtual_sol_reserves, trade_info.virtual_token_reserves, token_price));
        
        // Prepare swap parameters with reverse logic for discriminator
        let (_token_in, _token_out, discriminator) = match swap_config.swap_direction {
            SwapDirection::Buy => (*SOL_MINT, mint, *BUY_EXACT_QUOTE_IN_DISCRIMINATOR),
            SwapDirection::Sell => {
                if trade_info.is_reverse_when_pump_swap {
                    (mint, *SOL_MINT, *BUY_DISCRIMINATOR)
                } else {
                    (mint, *SOL_MINT, *SELL_DISCRIMINATOR)
                }
            },
        };
        
        let mut instructions = Vec::with_capacity(3); // Pre-allocate for typical case
        
        // Process swap direction using only parsed data
        let (base_amount, quote_amount, accounts) = match swap_config.swap_direction {
            SwapDirection::Buy => self.prepare_buy_swap_from_parsed(
                trade_info,
                owner,
                mint,
                pool_id,
                coin_creator,
                swap_config.amount_in,
                swap_config.slippage as u64,
                &mut instructions,
            ).await?,
            SwapDirection::Sell => {
                // For selling, this method should not be called directly
                // Use build_swap_from_parsed_data_with_balance instead
                return Err(anyhow!("For selling, use build_swap_from_parsed_data_with_balance method with cached balance"));
            },
        };
        
        // Add swap instruction if amount is valid
        if base_amount > 0 {
            if swap_config.swap_direction == SwapDirection::Buy {
                instructions.push(create_buy_exact_quote_instruction(
                    *PUMP_SWAP_PROGRAM,
                    quote_amount,
                    base_amount,
                    accounts,
                ));
            } else {
                instructions.push(create_swap_instruction(
                    *PUMP_SWAP_PROGRAM,
                    discriminator,
                    base_amount,
                    quote_amount,
                    accounts,
                ));
            }
        } else {
            return Err(anyhow!("Invalid swap amount"));
        }
        
        logger.log(format!("Built swap instruction in {:?}", start_time.elapsed()));
        Ok((self.keypair.clone(), instructions, token_price))
    }

    /// Build swap transaction with cached token balance (for selling without RPC calls)
    pub async fn build_swap_from_parsed_data_with_balance(
        &self,
        trade_info: &crate::engine::transaction_parser::TradeInfoFromToken,
        swap_config: SwapConfig,
        cached_balance: Option<(u64, u8)>, // (raw_balance, decimals) - None for buying
    ) -> Result<(Arc<Keypair>, Vec<Instruction>, f64)> {
        let logger = Logger::new("[PUMPSWAP-WITH-BALANCE] => ".blue().to_string());
        let start_time = std::time::Instant::now();
        
        // Early validation
        if trade_info.dex_type != DexType::PumpSwap {
            return Err(anyhow!("Invalid transaction type"));
        }
        
        let mint = Pubkey::from_str(&trade_info.mint)?;
        let owner = self.keypair.pubkey();
        
        // Extract all needed data from TradeInfoFromToken
        let pool_id = Pubkey::from_str(&trade_info.pool_id)?;
        let coin_creator = if let Some(ref creator_str) = trade_info.coin_creator {
            Pubkey::from_str(creator_str)?
        } else {
            return Err(anyhow!("Coin creator not found in trade info"));
        };
        
        // Use virtual reserves from trade_info for calculations
        let token_price = Self::calculate_price_from_virtual_reserves(
            trade_info.virtual_sol_reserves,
            trade_info.virtual_token_reserves,
        );
        
        logger.log(format!("Using cached balance for PumpSwap - Pool: {}, Price: {}", pool_id, token_price));
        
        // Prepare swap parameters
        let (_token_in, _token_out, discriminator) = match swap_config.swap_direction {
            SwapDirection::Buy => (*SOL_MINT, mint, *BUY_EXACT_QUOTE_IN_DISCRIMINATOR),
            SwapDirection::Sell => (mint, *SOL_MINT, *SELL_DISCRIMINATOR),
        };
        
        let mut instructions = Vec::with_capacity(3);
        
        // Process swap direction
        let (base_amount, quote_amount, accounts) = match swap_config.swap_direction {
            SwapDirection::Buy => self.prepare_buy_swap_from_parsed(
                trade_info,
                owner,
                mint,
                pool_id,
                coin_creator,
                swap_config.amount_in,
                swap_config.slippage as u64,
                &mut instructions,
            ).await?,
            SwapDirection::Sell => {
                // Use cached balance for selling
                if cached_balance.is_none() {
                    return Err(anyhow!("Cached balance required for selling"));
                }
                
                self.prepare_sell_swap_with_cached_balance(
                    trade_info,
                    owner,
                    mint,
                    pool_id,
                    coin_creator,
                    swap_config.amount_in,
                    swap_config.in_type,
                    swap_config.slippage as u64,
                    cached_balance.unwrap(),
                    &mut instructions,
                ).await?
            },
        };
        
        // Add swap instruction if amount is valid
        if base_amount > 0 {
            if swap_config.swap_direction == SwapDirection::Buy {
                instructions.push(create_buy_exact_quote_instruction(
                    *PUMP_SWAP_PROGRAM,
                    quote_amount,
                    base_amount,
                    accounts,
                ));
            } else {
                instructions.push(create_swap_instruction(
                    *PUMP_SWAP_PROGRAM,
                    discriminator,
                    base_amount,
                    quote_amount,
                    accounts,
                ));
            }
        } else {
            return Err(anyhow!("Invalid swap amount"));
        }
        
        logger.log(format!("Built swap instruction with cached balance in {:?}", start_time.elapsed()));
        Ok((self.keypair.clone(), instructions, token_price))
    }
    
    // Helper methods using only parsed data
    async fn prepare_buy_swap_from_parsed(
        &self,
        trade_info: &crate::engine::transaction_parser::TradeInfoFromToken,
        owner: Pubkey,
        mint: Pubkey,
        pool_id: Pubkey,
        coin_creator: Pubkey,
        amount_in: f64,
        slippage_bps: u64,
        instructions: &mut Vec<Instruction>,
    ) -> Result<(u64, u64, Vec<AccountMeta>)> {
        let amount_specified = ui_amount_to_amount(amount_in, 9);
        let token_program = self.get_token_program(&mint).await.unwrap_or(*TOKEN_PROGRAM);
        
        // Use virtual reserves for calculation
        let base_amount_out = Self::calculate_buy_token_amount_with_fees(
            amount_specified,
            trade_info.virtual_sol_reserves,
            trade_info.virtual_token_reserves,
            DEFAULT_PUMPSWAP_TOTAL_BUY_FEE_BPS,
            BUY_BASE_OUT_SAFETY_BPS,
        );
        
        let max_quote_amount_in = max_amount_with_slippage(amount_specified, slippage_bps);
        let out_ata = get_associated_token_address_with_program_id(&owner, &mint, &token_program);
        
        println!("Preparing buy swap - Token ATA: {}, WSOL ATA: {}, Token Program: {}", 
            out_ata, get_associated_token_address(&owner, &SOL_MINT), token_program);
        
        // Always check if token account exists and create if needed
        // The cache might not contain all user accounts, so we need to be more robust
        let token_account_exists = self.check_token_account_cache(out_ata).await;
        if !token_account_exists {
            println!("Creating token ATA for mint: {} at address: {}", mint, out_ata);
            // Add ATA creation instruction - this ensures the token account exists
            instructions.push(create_associated_token_account_idempotent(
                &owner,
                &owner,
                &mint,
                &token_program,
            ));
            // Cache the account for future use
            self.cache_token_account(out_ata).await;
        } else {
            println!("Token ATA already exists in cache: {}", out_ata);
        }
        
        // Always check if WSOL account exists for buying (WSOL always uses TOKEN_PROGRAM)
        let wsol_ata = get_associated_token_address(&owner, &SOL_MINT);
        let wsol_account_exists = self.check_token_account_cache(wsol_ata).await;
        if !wsol_account_exists {
            println!("Creating WSOL ATA at address: {}", wsol_ata);
            instructions.push(create_associated_token_account_idempotent(
                &owner,
                &owner,
                &SOL_MINT,
                &TOKEN_PROGRAM,
            ));
            self.cache_token_account(wsol_ata).await;
        } else {
            println!("WSOL ATA already exists in cache: {}", wsol_ata);
        }

        // Fund the WSOL ATA with the max quote amount the swap may spend, then sync it.
        instructions.push(system_instruction::transfer(
            &owner,
            &wsol_ata,
            max_quote_amount_in,
        ));
        instructions.push(sync_native(&spl_token::id(), &wsol_ata)?);
        
        // Ensure fee recipient WSOL ATA exists (program expects it initialized)
        let fee_recipient_ata = get_associated_token_address(&PUMP_SWAP_FEE_RECIPIENT, &SOL_MINT);
        instructions.push(create_associated_token_account_idempotent(
            &owner,
            &PUMP_SWAP_FEE_RECIPIENT,
            &SOL_MINT,
            &TOKEN_PROGRAM,
        ));
        
        // Ensure coin creator vault authority WSOL ATA exists
        let (coin_creator_vault_authority, _) = Pubkey::find_program_address(
            &[b"creator_vault", coin_creator.as_ref()],
            &PUMP_SWAP_PROGRAM,
        );
        let coin_creator_vault_ata = get_associated_token_address(&coin_creator_vault_authority, &SOL_MINT);
        instructions.push(create_associated_token_account_idempotent(
            &owner,
            &coin_creator_vault_authority,
            &SOL_MINT,
            &TOKEN_PROGRAM,
        ));
        
        println!("Total instructions before swap: {} (ATA creation + swap)", instructions.len());
        
        // Create accounts using parsed pool_id and coin_creator
        let pool_base_account = get_associated_token_address_with_program_id(&pool_id, &mint, &token_program);
        let pool_quote_account = get_associated_token_address(&pool_id, &SOL_MINT);
        
        // Get volume accumulator PDAs
        let global_volume_accumulator = get_global_volume_accumulator_pda()?;
        let user_volume_accumulator = get_user_volume_accumulator_pda(&owner)?;
        

        let accounts = create_buy_accounts(
            pool_id,
            owner,
            mint,
            *SOL_MINT,
            out_ata,
            get_associated_token_address(&owner, &SOL_MINT),
            pool_base_account,
            pool_quote_account,
            coin_creator,
            token_program,
            *TOKEN_PROGRAM,
            global_volume_accumulator,
            user_volume_accumulator,
            trade_info.is_reverse_when_pump_swap,
        )?;

        
        // Return minimum base amount out and exact spendable quote amount for buy_exact_quote_in.
        Ok((base_amount_out, amount_specified, accounts))
    }
    
    async fn prepare_sell_swap_from_parsed(
        &self,
        trade_info: &crate::engine::transaction_parser::TradeInfoFromToken,
        owner: Pubkey,
        mint: Pubkey,
        pool_id: Pubkey,
        coin_creator: Pubkey,
        amount_in: f64,
        in_type: SwapInType,
        slippage_bps: u64,
        instructions: &mut Vec<Instruction>,
    ) -> Result<(u64, u64, Vec<AccountMeta>)> {
        let token_program = self.get_token_program(&mint).await.unwrap_or(*TOKEN_PROGRAM);
        let in_ata = get_associated_token_address_with_program_id(&owner, &mint, &token_program);
        
        println!("Preparing sell swap - Token ATA: {}, WSOL ATA: {}", 
            in_ata, get_associated_token_address(&owner, &SOL_MINT));
        
        // Verify token account exists using cache first
        if !self.check_token_account_cache(in_ata).await {
            return Err(anyhow!("Token account does not exist"));
        }
        
        // Ensure WSOL account exists for receiving SOL from sell
        let wsol_ata = get_associated_token_address(&owner, &SOL_MINT);
        let wsol_account_exists = self.check_token_account_cache(wsol_ata).await;
        if !wsol_account_exists {
            println!("Creating WSOL ATA for sell at address: {}", wsol_ata);
            instructions.push(create_associated_token_account_idempotent(
                &owner,
                &owner,
                &SOL_MINT,
                &TOKEN_PROGRAM,
            ));
            self.cache_token_account(wsol_ata).await;
        } else {
            println!("WSOL ATA already exists in cache: {}", wsol_ata);
        }
        
        // Ensure fee recipient WSOL ATA exists
        let fee_recipient_ata = get_associated_token_address(&PUMP_SWAP_FEE_RECIPIENT, &SOL_MINT);
        instructions.push(create_associated_token_account_idempotent(
            &owner,
            &PUMP_SWAP_FEE_RECIPIENT,
            &SOL_MINT,
            &TOKEN_PROGRAM,
        ));
        
        // Ensure coin creator vault authority WSOL ATA exists
        let (coin_creator_vault_authority, _) = Pubkey::find_program_address(
            &[b"creator_vault", coin_creator.as_ref()],
            &PUMP_SWAP_PROGRAM,
        );
        let coin_creator_vault_ata = get_associated_token_address(&coin_creator_vault_authority, &SOL_MINT);
        instructions.push(create_associated_token_account_idempotent(
            &owner,
            &coin_creator_vault_authority,
            &SOL_MINT,
            &TOKEN_PROGRAM,
        ));
        
        // Get token info in parallel
        let (account_info, mint_info) = if let Some(client) = &self.rpc_nonblocking_client {
            let account_fut = token::get_account_info(client.clone(), mint, in_ata);
            let mint_fut = token::get_mint_info(client.clone(), self.keypair.clone(), mint);
            tokio::try_join!(account_fut, mint_fut)?
        } else {
            return Err(anyhow!("RPC client not available"));
        };
        
        let amount = match in_type {
            SwapInType::Qty => ui_amount_to_amount(amount_in, mint_info.base.decimals),
            SwapInType::Pct => {
                let pct = amount_in.min(1.0);
                if pct == 1.0 {
                    // Close account if selling 100%
                    instructions.push(spl_token::instruction::close_account(
                        &TOKEN_PROGRAM,
                        &in_ata,
                        &owner,
                        &owner,
                        &[&owner],
                    )?);
                    account_info.base.amount
                } else {
                    (pct * account_info.base.amount as f64) as u64
                }
            }
        };
        
        if amount == 0 {
            return Err(anyhow!("Invalid sell amount"));
        }
        
        // Use virtual reserves for calculation
        let quote_amount_out = Self::calculate_sell_sol_amount(
            amount,
            trade_info.virtual_sol_reserves,
            trade_info.virtual_token_reserves,
        );
        
        let min_quote_amount_out = 0;  // this ensures must sell
        println!("Sell calculation - Tokens in: {}, Expected SOL out: {}, Virtual SOL: {}, Virtual Tokens: {}", 
            amount, quote_amount_out, trade_info.virtual_sol_reserves, trade_info.virtual_token_reserves);

        // Create accounts using parsed pool_id and coin_creator
        let pool_base_account = get_associated_token_address_with_program_id(&pool_id, &mint, &token_program);
        let pool_quote_account = get_associated_token_address(&pool_id, &SOL_MINT);

        let accounts = create_sell_accounts(
            pool_id,
            owner,
            mint,
            *SOL_MINT,
            in_ata,
            get_associated_token_address(&owner, &SOL_MINT),
            pool_base_account,
            pool_quote_account,
            coin_creator,
            token_program,
            *TOKEN_PROGRAM,
            trade_info.is_reverse_when_pump_swap,
        )?;
        
        println!("Total instructions before sell swap: {} (WSOL ATA creation + close account if 100% + sell)", instructions.len());
        
        Ok((amount, min_quote_amount_out, accounts))
    }

    /// Prepare sell swap using cached balance instead of RPC calls
    async fn prepare_sell_swap_with_cached_balance(
        &self,
        trade_info: &crate::engine::transaction_parser::TradeInfoFromToken,
        owner: Pubkey,
        mint: Pubkey,
        pool_id: Pubkey,
        coin_creator: Pubkey,
        amount_in: f64,
        in_type: SwapInType,
        slippage_bps: u64,
        cached_balance: (u64, u8), // (raw_balance, decimals)
        instructions: &mut Vec<Instruction>,
    ) -> Result<(u64, u64, Vec<AccountMeta>)> {
        let token_program = self.get_token_program(&mint).await.unwrap_or(*TOKEN_PROGRAM);
        let in_ata = get_associated_token_address_with_program_id(&owner, &mint, &token_program);
        let (balance_raw, token_decimals) = cached_balance;
        
        println!("Preparing sell swap with cached balance - Token ATA: {}, WSOL ATA: {}", 
            in_ata, get_associated_token_address(&owner, &SOL_MINT));
        
        // Ensure WSOL account exists for receiving SOL from sell
        let wsol_ata = get_associated_token_address(&owner, &SOL_MINT);
        let wsol_account_exists = self.check_token_account_cache(wsol_ata).await;
        if !wsol_account_exists {
            println!("Creating WSOL ATA for sell with cached balance at address: {}", wsol_ata);
            instructions.push(create_associated_token_account_idempotent(
                &owner,
                &owner,
                &SOL_MINT,
                &TOKEN_PROGRAM,
            ));
            self.cache_token_account(wsol_ata).await;
        } else {
            println!("WSOL ATA already exists in cache: {}", wsol_ata);
        }
        
        // Ensure fee recipient WSOL ATA exists
        let fee_recipient_ata = get_associated_token_address(&PUMP_SWAP_FEE_RECIPIENT, &SOL_MINT);
        instructions.push(create_associated_token_account_idempotent(
            &owner,
            &PUMP_SWAP_FEE_RECIPIENT,
            &SOL_MINT,
            &TOKEN_PROGRAM,
        ));
        
        // Ensure coin creator vault authority WSOL ATA exists
        let (coin_creator_vault_authority, _) = Pubkey::find_program_address(
            &[b"creator_vault", coin_creator.as_ref()],
            &PUMP_SWAP_PROGRAM,
        );
        let coin_creator_vault_ata = get_associated_token_address(&coin_creator_vault_authority, &SOL_MINT);
        instructions.push(create_associated_token_account_idempotent(
            &owner,
            &coin_creator_vault_authority,
            &SOL_MINT,
            &TOKEN_PROGRAM,
        ));
        
        // Calculate amount to sell from cached balance
        let amount = match in_type {
            SwapInType::Qty => ui_amount_to_amount(amount_in, token_decimals),
            SwapInType::Pct => {
                let pct = amount_in.min(1.0);
                if pct == 1.0 {
                    // Close account if selling 100%
                    instructions.push(spl_token::instruction::close_account(
                        &TOKEN_PROGRAM,
                        &in_ata,
                        &owner,
                        &owner,
                        &[&owner],
                    )?);
                    balance_raw
                } else {
                    (pct * balance_raw as f64) as u64
                }
            }
        };
        
        if amount == 0 {
            return Err(anyhow!("Invalid sell amount"));
        }
        
        if amount > balance_raw {
            return Err(anyhow!("Insufficient balance: trying to sell {} but only have {}", amount, balance_raw));
        }
        
        // Use virtual reserves for calculation
        let quote_amount_out = Self::calculate_sell_sol_amount(
            amount,
            trade_info.virtual_sol_reserves,
            trade_info.virtual_token_reserves,
        );
        
        let min_quote_amount_out = 0;  // this ensures must sell
        println!("Sell calculation - Tokens in: {} (from cached balance: {}), Expected SOL out: {}, Virtual SOL: {}, Virtual Tokens: {}", 
            amount, balance_raw, quote_amount_out, trade_info.virtual_sol_reserves, trade_info.virtual_token_reserves);
        
        // Create accounts using parsed pool_id and coin_creator
        let pool_base_account = get_associated_token_address_with_program_id(&pool_id, &mint, &token_program);
        let pool_quote_account = get_associated_token_address(&pool_id, &SOL_MINT);
        
        let accounts = create_sell_accounts(
            pool_id,
            owner,
            mint,
            *SOL_MINT,
            in_ata,
            get_associated_token_address(&owner, &SOL_MINT),
            pool_base_account,
            pool_quote_account,
            coin_creator,
            token_program,
            *TOKEN_PROGRAM,
            trade_info.is_reverse_when_pump_swap,
        )?;
        
        println!("Total instructions before sell swap with cached balance: {} (WSOL ATA creation + close account if 100% + sell)", instructions.len());
        
        // Return token amount in and min SOL amount out for sell orders
        Ok((amount, min_quote_amount_out, accounts))
    }
    
    async fn check_token_account_cache(&self, account: Pubkey) -> bool {
        let exists = WALLET_TOKEN_ACCOUNTS.contains(&account);
        if !exists {
            // Log when cache miss occurs to help with debugging
            println!("Cache miss for token account: {} - will create ATA", account);
        }
        exists
    }
    
    async fn cache_token_account(&self, account: Pubkey) {
        WALLET_TOKEN_ACCOUNTS.insert(account);
    }
    
    /// Helper method to determine the correct token program for a mint
    async fn get_token_program(&self, mint: &Pubkey) -> Result<Pubkey> {
        if let Some(rpc_client) = &self.rpc_client {
            match rpc_client.get_account(mint) {
                Ok(account) => {
                    if account.owner == *TOKEN_2022_PROGRAM {
                        Ok(*TOKEN_2022_PROGRAM)
                    } else {
                        Ok(*TOKEN_PROGRAM)
                    }
                },
                Err(_) => {
                    // Default to TOKEN_PROGRAM if we can't fetch the account
                    Ok(*TOKEN_PROGRAM)
                }
            }
        } else {
            // Default to TOKEN_PROGRAM if no RPC client
            Ok(*TOKEN_PROGRAM)
        }
    }
    
    /// Populate cache with existing token accounts for the user
    /// This helps reduce unnecessary ATA creation instructions
    pub async fn populate_token_account_cache(&self, owner: &Pubkey) -> Result<()> {
        if let Some(rpc_client) = &self.rpc_client {
            // Query SPL Token program accounts
            let mut cached_count: usize = 0;
            let accounts_spl = rpc_client.get_token_accounts_by_owner(
                owner,
                TokenAccountsFilter::ProgramId(*TOKEN_PROGRAM),
            )?;
            for keyed in &accounts_spl {
                if let Ok(pk) = Pubkey::from_str(&keyed.pubkey) {
                    self.cache_token_account(pk).await;
                    cached_count += 1;
                }
            }

            // Query Token-2022 program accounts as well
            let accounts_2022 = rpc_client.get_token_accounts_by_owner(
                owner,
                TokenAccountsFilter::ProgramId(*TOKEN_2022_PROGRAM),
            ).unwrap_or_default();
            for keyed in &accounts_2022 {
                if let Ok(pk) = Pubkey::from_str(&keyed.pubkey) {
                    self.cache_token_account(pk).await;
                    cached_count += 1;
                }
            }

            println!("Cached {} existing token accounts for owner {}", cached_count, owner);
            
            // Also cache WSOL account if it exists
            let wsol_ata = get_associated_token_address(owner, &SOL_MINT);
            if let Ok(wsol_account) = rpc_client.get_account(&wsol_ata) {
                if wsol_account.owner == *TOKEN_PROGRAM {
                    self.cache_token_account(wsol_ata).await;
                    println!("Cached existing WSOL account: {}", wsol_ata);
                }
            }
        }
        Ok(())
    }
    
    /// Manually populate the cache for the current user
    /// Call this method after creating a PumpSwap instance to populate the cache
    pub async fn populate_cache_for_current_user(&self) -> Result<()> {
        let owner = self.keypair.pubkey();
        self.populate_token_account_cache(&owner).await
    }

    /// Calculate token amount out for buy using virtual reserves (PumpSwap AMM formula)
    pub fn calculate_buy_token_amount(
        sol_amount_in: u64,
        virtual_sol_reserves: u64,
        virtual_token_reserves: u64,
    ) -> u64 {
        if sol_amount_in == 0 || virtual_sol_reserves == 0 || virtual_token_reserves == 0 {
            return 0;
        }
        
        // PumpSwap AMM formula for buy (same as PumpFun):
        // tokens_out = (sol_in * virtual_token_reserves) / (virtual_sol_reserves + sol_in)
        let sol_amount_in_u128 = sol_amount_in as u128;
        let virtual_sol_reserves_u128 = virtual_sol_reserves as u128;
        let virtual_token_reserves_u128 = virtual_token_reserves as u128;
        
        let numerator = sol_amount_in_u128.saturating_mul(virtual_token_reserves_u128);
        let denominator = virtual_sol_reserves_u128.saturating_add(sol_amount_in_u128);
        
        if denominator == 0 {
            return 0;
        }
        
        numerator.checked_div(denominator).unwrap_or(0) as u64
    }

    pub fn calculate_buy_token_amount_with_fees(
        quote_amount_in: u64,
        quote_reserve: u64,
        base_reserve: u64,
        total_fee_bps: u64,
        safety_bps: u64,
    ) -> u64 {
        if quote_amount_in == 0 || quote_reserve == 0 || base_reserve == 0 {
            return 0;
        }

        let denominator_bps = TEN_THOUSAND.saturating_add(total_fee_bps);
        if denominator_bps == 0 {
            return 0;
        }

        let effective_quote = (quote_amount_in as u128)
            .saturating_mul(TEN_THOUSAND as u128)
            / (denominator_bps as u128);
        if effective_quote == 0 {
            return 0;
        }

        let numerator = (base_reserve as u128).saturating_mul(effective_quote);
        let denominator = (quote_reserve as u128).saturating_add(effective_quote);
        if denominator == 0 {
            return 0;
        }

        let raw_base_out = numerator / denominator;
        let safe_base_out = raw_base_out
            .saturating_mul(TEN_THOUSAND.saturating_sub(safety_bps) as u128)
            / (TEN_THOUSAND as u128);

        safe_base_out.min(base_reserve.saturating_sub(1) as u128) as u64
    }

    /// Calculate SOL amount out for sell using virtual reserves (PumpSwap AMM formula)
    pub fn calculate_sell_sol_amount(
        token_amount_in: u64,
        virtual_sol_reserves: u64,
        virtual_token_reserves: u64,
    ) -> u64 {
        if token_amount_in == 0 || virtual_sol_reserves == 0 || virtual_token_reserves == 0 {
            return 0;
        }
        
        // PumpSwap constant product AMM formula for sell:
        // sol_out = (token_in * virtual_sol_reserves) / (virtual_token_reserves + token_in)
        let token_amount_in_u128 = token_amount_in as u128;
        let virtual_sol_reserves_u128 = virtual_sol_reserves as u128;
        let virtual_token_reserves_u128 = virtual_token_reserves as u128;
        
        let numerator = token_amount_in_u128.saturating_mul(virtual_sol_reserves_u128);
        let denominator = virtual_token_reserves_u128.saturating_add(token_amount_in_u128);
        
        if denominator == 0 {
            return 0;
        }
        
        numerator.checked_div(denominator).unwrap_or(0) as u64
    }

    /// Calculate price using virtual reserves
    pub fn calculate_price_from_virtual_reserves(
        virtual_sol_reserves: u64,
        virtual_token_reserves: u64,
    ) -> f64 {
        if virtual_token_reserves == 0 {
            return 0.0;
        }
        
        // Price = virtual_sol_reserves / virtual_token_reserves
        (virtual_sol_reserves as f64) / (virtual_token_reserves as f64)
    }
}

/// Minimal pool info for price queries only (returns pool_id, base_reserve, quote_reserve)
async fn get_pool_info_for_price(
    rpc_client: Arc<anchor_client::solana_client::rpc_client::RpcClient>,
    mint: Pubkey,
) -> Result<(Pubkey, u64, u64)> {
    let _logger = Logger::new("[PUMPSWAP-PRICE-QUERY] => ".blue().to_string());

    // Initialize
    let sol_mint = *SOL_MINT;
    let pump_program = *PUMP_SWAP_PROGRAM;
    let token_program = match rpc_client.get_account(&mint) {
        Ok(account) if account.owner == *TOKEN_2022_PROGRAM => *TOKEN_2022_PROGRAM,
        _ => *TOKEN_PROGRAM,
    };

    let read_token_account_owner = |data: &[u8]| -> Option<Pubkey> {
        if data.len() < 64 {
            return None;
        }
        Pubkey::try_from(&data[32..64]).ok()
    };

    let read_token_account_amount = |data: &[u8]| -> Option<u64> {
        if data.len() < 72 {
            return None;
        }
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&data[64..72]);
        Some(u64::from_le_bytes(bytes))
    };
    
    // Find the pool
    let mut pool_id = Pubkey::default();
    match rpc_client.get_program_accounts_with_config(
        &pump_program,
        RpcProgramAccountsConfig {
            filters: Some(vec![
                RpcFilterType::DataSize(300),
                RpcFilterType::Memcmp(Memcmp::new(43, MemcmpEncodedBytes::Base64(base64::encode(mint.to_bytes())))),
            ]),
            account_config: RpcAccountInfoConfig {
                encoding: Some(UiAccountEncoding::Base64),
                ..Default::default()
            },
            ..Default::default()
        },
    ) {
        Ok(accounts) => {
            for (pubkey, account) in accounts.iter() {
                if account.data.len() >= 75 {
                    if let Ok(pubkey_from_data) = Pubkey::try_from(&account.data[43..75]) {
                        if pubkey_from_data == mint {
                            pool_id = *pubkey;
                            break;
                        }
                    }
                }
            }
        }
        Err(err) => {
            return Err(anyhow!("Error getting program accounts: {}", err));
        }
    }
    
    if pool_id == Pubkey::default() {
        if let Ok(largest_accounts) = rpc_client.get_token_largest_accounts(&mint) {
            for largest in largest_accounts {
                let token_account_pubkey = match Pubkey::from_str(&largest.address) {
                    Ok(pubkey) => pubkey,
                    Err(_) => continue,
                };
                let token_account_data = match rpc_client.get_account(&token_account_pubkey) {
                    Ok(account) => account.data,
                    Err(_) => continue,
                };
                let candidate_pool = if token_program == *TOKEN_2022_PROGRAM {
                    match read_token_account_owner(&token_account_data) {
                        Some(owner) => owner,
                        None => continue,
                    }
                } else {
                    match spl_token::state::Account::unpack(&token_account_data) {
                        Ok(account) => account.owner,
                        Err(_) => match read_token_account_owner(&token_account_data) {
                            Some(owner) => owner,
                            None => continue,
                        }
                    }
                };
                let candidate_pool_account = match rpc_client.get_account(&candidate_pool) {
                    Ok(account) => account,
                    Err(_) => continue,
                };
                if candidate_pool_account.owner == pump_program {
                    pool_id = candidate_pool;
                    break;
                }
            }
        }
    }

    if pool_id == Pubkey::default() {
        return Err(anyhow!("Failed to find PumpSwap pool for mint {}", mint));
    }
    
    // Derive token accounts
    let pool_base_account = get_associated_token_address_with_program_id(&pool_id, &mint, &token_program);
    let pool_quote_account = get_associated_token_address(&pool_id, &sol_mint);
    
    // Get token balances
    let accounts = rpc_client.get_multiple_accounts(&[pool_base_account, pool_quote_account])?;
    
    // Extract balances
    let base_balance = if let Some(account_data) = &accounts[0] {
        read_token_account_amount(&account_data.data).unwrap_or(10_000_000_000_000)
    } else {
        10_000_000_000_000 // Fallback
    };
    
    let quote_balance = if let Some(account_data) = &accounts[1] {
        read_token_account_amount(&account_data.data).unwrap_or(10_000_000_000)
    } else {
        10_000_000_000 // Fallback
    };
    
    Ok((pool_id, base_balance, quote_balance))
}

// Optimized math functions with overflow protection
#[inline]
fn calculate_buy_base_amount(quote_amount_in: u64, quote_reserve: u64, base_reserve: u64) -> u64 {
    if quote_amount_in == 0 || base_reserve == 0 || quote_reserve == 0 {
        return 0;
    }
    
    let quote_reserve_after = quote_reserve.saturating_add(quote_amount_in);
    let numerator = (quote_reserve as u128).saturating_mul(base_reserve as u128);
    let denominator = quote_reserve_after as u128;
    
    if denominator == 0 {
        return 0;
    }
    
    let base_reserve_after = numerator.checked_div(denominator).unwrap_or(0);
    base_reserve.saturating_sub(base_reserve_after as u64)
}

#[inline]
fn calculate_sell_quote_amount(base_amount_in: u64, base_reserve: u64, quote_reserve: u64) -> u64 {
    if base_amount_in == 0 || base_reserve == 0 || quote_reserve == 0 {
        return 0;
    }
    
    let base_reserve_after = base_reserve.saturating_add(base_amount_in);
    let numerator = (quote_reserve as u128).saturating_mul(base_reserve as u128);
    let denominator = base_reserve_after as u128;
    
    if denominator == 0 {
        return 0;
    }
    
    let quote_reserve_after = numerator.checked_div(denominator).unwrap_or(0);
    quote_reserve.saturating_sub(quote_reserve_after as u64)
}

#[inline]
fn min_amount_with_slippage(input_amount: u64, slippage_bps: u64) -> u64 {
    input_amount
        .saturating_mul(TEN_THOUSAND.saturating_sub(slippage_bps))
        .checked_div(TEN_THOUSAND)
        .unwrap_or(0)
}

#[inline]
fn max_amount_with_slippage(input_amount: u64, slippage_bps: u64) -> u64 {
    input_amount
        .saturating_mul(TEN_THOUSAND.saturating_add(slippage_bps))
        .checked_div(TEN_THOUSAND)
        .unwrap_or(input_amount)
}

// Optimized account creation with const pubkeys
fn create_buy_accounts(
    pool_id: Pubkey,
    user: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    user_base_token_account: Pubkey,
    wsol_account: Pubkey,
    pool_base_token_account: Pubkey,
    pool_quote_token_account: Pubkey,
    coin_creator: Pubkey,
    base_token_program: Pubkey,
    quote_token_program: Pubkey,
    global_volume_accumulator: Pubkey,
    user_volume_accumulator: Pubkey,
    is_reverse_when_pump_swap: bool,
) -> Result<Vec<AccountMeta>> {
    let (coin_creator_vault_authority, _) = Pubkey::find_program_address(
        &[b"creator_vault", coin_creator.as_ref()],
        &PUMP_SWAP_PROGRAM,
    );
    let fee_config = get_fee_config_pda();
    let (
        base_mint,
        quote_mint,
        user_base_token_account,
        user_quote_token_account,
        pool_base_token_account,
        pool_quote_token_account,
        base_token_program,
        quote_token_program,
    ) = if is_reverse_when_pump_swap {
        (
            quote_mint,
            base_mint,
            wsol_account,
            user_base_token_account,
            pool_quote_token_account,
            pool_base_token_account,
            quote_token_program,
            base_token_program,
        )
    } else {
        (
            base_mint,
            quote_mint,
            user_base_token_account,
            wsol_account,
            pool_base_token_account,
            pool_quote_token_account,
            base_token_program,
            quote_token_program,
        )
    };
    let coin_creator_vault_ata = get_associated_token_address_with_program_id(
        &coin_creator_vault_authority,
        &quote_mint,
        &quote_token_program,
    );
    let protocol_fee_recipient_token_account = get_associated_token_address_with_program_id(
        &PUMP_SWAP_FEE_RECIPIENT,
        &quote_mint,
        &quote_token_program,
    );
    let buyback_fee_recipient_token_account = get_associated_token_address_with_program_id(
        &DEFAULT_BUYBACK_FEE_RECIPIENT,
        &quote_mint,
        &quote_token_program,
    );

    let mut accounts = vec![
        AccountMeta::new(pool_id, false),
        AccountMeta::new(user, true),
        AccountMeta::new_readonly(*PUMP_GLOBAL_CONFIG, false),
        AccountMeta::new_readonly(base_mint, false),
        AccountMeta::new_readonly(quote_mint, false),
        AccountMeta::new(user_base_token_account, false),
        AccountMeta::new(user_quote_token_account, false),
        AccountMeta::new(pool_base_token_account, false),
        AccountMeta::new(pool_quote_token_account, false),
        AccountMeta::new_readonly(*PUMP_SWAP_FEE_RECIPIENT, false),
        AccountMeta::new(protocol_fee_recipient_token_account, false),
        AccountMeta::new_readonly(base_token_program, false),
        AccountMeta::new_readonly(quote_token_program, false),
        AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new_readonly(*ASSOCIATED_TOKEN_PROGRAM, false),
        AccountMeta::new_readonly(*PUMP_EVENT_AUTHORITY, false),
        AccountMeta::new_readonly(*PUMP_SWAP_PROGRAM, false),
        AccountMeta::new(coin_creator_vault_ata, false),
        AccountMeta::new_readonly(coin_creator_vault_authority, false),
        AccountMeta::new_readonly(global_volume_accumulator, false),
        AccountMeta::new(user_volume_accumulator, false),
        AccountMeta::new_readonly(fee_config, false),
        AccountMeta::new_readonly(*PUMP_FEE_PROGRAM, false),
    ];

    if coin_creator != Pubkey::default() {
        accounts.push(AccountMeta::new_readonly(get_pool_v2_pda(&base_mint), false));
    }

    accounts.push(AccountMeta::new_readonly(*DEFAULT_BUYBACK_FEE_RECIPIENT, false));
    accounts.push(AccountMeta::new(buyback_fee_recipient_token_account, false));

    Ok(accounts)
}

// Similar optimization for sell accounts
fn create_sell_accounts(
    pool_id: Pubkey,
    user: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    user_base_token_account: Pubkey,
    wsol_account: Pubkey,
    pool_base_token_account: Pubkey,
    pool_quote_token_account: Pubkey,
    coin_creator: Pubkey,
    base_token_program: Pubkey,
    quote_token_program: Pubkey,
    is_reverse_when_pump_swap: bool,
) -> Result<Vec<AccountMeta>> {

    let (coin_creator_vault_authority, _) = Pubkey::find_program_address(
        &[b"creator_vault", coin_creator.as_ref()],
        &PUMP_SWAP_PROGRAM,
    );
    let fee_config = get_fee_config_pda();
    let (
        base_mint,
        quote_mint,
        user_base_token_account,
        user_quote_token_account,
        pool_base_token_account,
        pool_quote_token_account,
        base_token_program,
        quote_token_program,
    ) = if is_reverse_when_pump_swap {
        (
            quote_mint,
            base_mint,
            wsol_account,
            user_base_token_account,
            pool_quote_token_account,
            pool_base_token_account,
            quote_token_program,
            base_token_program,
        )
    } else {
        (
            base_mint,
            quote_mint,
            user_base_token_account,
            wsol_account,
            pool_base_token_account,
            pool_quote_token_account,
            base_token_program,
            quote_token_program,
        )
    };
    let coin_creator_vault_ata = get_associated_token_address_with_program_id(
        &coin_creator_vault_authority,
        &quote_mint,
        &quote_token_program,
    );
    let protocol_fee_recipient_token_account = get_associated_token_address_with_program_id(
        &PUMP_SWAP_FEE_RECIPIENT,
        &quote_mint,
        &quote_token_program,
    );

    Ok(vec![
        AccountMeta::new(pool_id, false),
        AccountMeta::new(user, true),
        AccountMeta::new_readonly(*PUMP_GLOBAL_CONFIG, false),
        AccountMeta::new_readonly(base_mint, false),
        AccountMeta::new_readonly(quote_mint, false),
        AccountMeta::new(user_base_token_account, false),
        AccountMeta::new(user_quote_token_account, false),
        AccountMeta::new(pool_base_token_account, false),
        AccountMeta::new(pool_quote_token_account, false),
        AccountMeta::new_readonly(*PUMP_SWAP_FEE_RECIPIENT, false),
        AccountMeta::new(protocol_fee_recipient_token_account, false),
        AccountMeta::new_readonly(base_token_program, false),
        AccountMeta::new_readonly(quote_token_program, false),
        AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new_readonly(*ASSOCIATED_TOKEN_PROGRAM, false),
        AccountMeta::new_readonly(*PUMP_EVENT_AUTHORITY, false),
        AccountMeta::new_readonly(*PUMP_SWAP_PROGRAM, false),
        AccountMeta::new(coin_creator_vault_ata, false),
        AccountMeta::new_readonly(coin_creator_vault_authority, false),
        AccountMeta::new_readonly(fee_config, false),
        AccountMeta::new_readonly(*PUMP_FEE_PROGRAM, false),
    ])
}

// Optimized instruction creation
fn create_swap_instruction(
    program_id: Pubkey,
    discriminator: [u8; 8],
    base_amount: u64,
    quote_amount: u64,
    accounts: Vec<AccountMeta>,
) -> Instruction {
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(&base_amount.to_le_bytes());
    data.extend_from_slice(&quote_amount.to_le_bytes());
    
    Instruction { program_id, accounts, data }
}

fn create_buy_exact_quote_instruction(
    program_id: Pubkey,
    spendable_quote_in: u64,
    min_base_amount_out: u64,
    accounts: Vec<AccountMeta>,
) -> Instruction {
    let mut data = Vec::with_capacity(25);
    data.extend_from_slice(&*BUY_EXACT_QUOTE_IN_DISCRIMINATOR);
    data.extend_from_slice(&spendable_quote_in.to_le_bytes());
    data.extend_from_slice(&min_base_amount_out.to_le_bytes());
    // OptionBool { 0: true }
    data.push(1);

    Instruction { program_id, accounts, data }
}
