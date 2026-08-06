use std::{str::FromStr, sync::Arc};
use anyhow::{anyhow, Result};
use borsh::from_slice;
use tokio::time::Instant;
use borsh_derive::{BorshDeserialize, BorshSerialize};
use colored::Colorize;
use serde::{Deserialize, Serialize};
use anchor_client::solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    system_program,
};
use spl_associated_token_account::{
    get_associated_token_address,
    get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};
use spl_token::{ui_amount_to_amount};
use tokio::sync::OnceCell;
use lru::LruCache;
use std::num::NonZeroUsize;
use rand::{seq::SliceRandom, thread_rng};

use crate::{
    common::{config::SwapConfig, logger::Logger, cache::WALLET_TOKEN_ACCOUNTS},
    engine::{monitor::BondingCurveInfo, swap::{SwapDirection, SwapInType}},
};

fn decode_bonding_curve_account(data: &[u8]) -> Result<BondingCurveAccount> {
    match from_slice::<BondingCurveAccount>(data) {
        Ok(account) => Ok(account),
        Err(_) => decode_bonding_curve_account_prefix(data),
    }
}

fn decode_bonding_curve_account_prefix(data: &[u8]) -> Result<BondingCurveAccount> {
    const MIN_LEN: usize = 83;
    if data.len() < MIN_LEN {
        return Err(anyhow!(
            "Bonding curve account too short: expected at least {} bytes, got {}",
            MIN_LEN,
            data.len()
        ));
    }

    let read_u64 = |start: usize| -> u64 {
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&data[start..start + 8]);
        u64::from_le_bytes(bytes)
    };

    let creator = Pubkey::try_from(&data[49..81])
        .map_err(|e| anyhow!("Failed to parse creator pubkey: {}", e))?;

    Ok(BondingCurveAccount {
        discriminator: read_u64(0),
        virtual_token_reserves: read_u64(8),
        virtual_sol_reserves: read_u64(16),
        real_token_reserves: read_u64(24),
        real_sol_reserves: read_u64(32),
        token_total_supply: read_u64(40),
        complete: data[48] != 0,
        creator,
        is_mayhem_mode: data[81] != 0,
        is_cashback_coin: data[82] != 0,
    })
}

// Constants for cache
const CACHE_SIZE: usize = 1000;

// Thread-safe cache with LRU eviction policy
static TOKEN_ACCOUNT_CACHE: OnceCell<LruCache<Pubkey, bool>> = OnceCell::const_new();

async fn init_caches() {
    TOKEN_ACCOUNT_CACHE.get_or_init(|| async {
        LruCache::new(NonZeroUsize::new(CACHE_SIZE).unwrap())
    }).await;
}

pub const TEN_THOUSAND: u64 = 10000;
pub const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const TOKEN_2022_PROGRAM: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
pub const RENT_PROGRAM: &str = "SysvarRent111111111111111111111111111111111";
pub const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const PUMP_GLOBAL: &str = "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf";
pub const PUMP_FEE_RECIPIENT: &str = "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM";
pub const PUMP_FUN_PROGRAM: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
pub const PUMP_FUN_FEE_CONFIG: &str = "8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt";
pub const PUMP_FUN_FEE_PROGRAM: &str = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";


// pub const PUMP_FUN_MINT_AUTHORITY: &str = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM";
pub const PUMP_EVENT_AUTHORITY: &str = "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1";
pub const PUMP_BUY_METHOD: u64 = 16927863322537952870;
pub const PUMP_SELL_METHOD: u64 = 12502976635542562355;
pub const PUMP_BUY_V2_DISCRIMINATOR: [u8; 8] = [184, 23, 238, 97, 103, 197, 211, 61];
pub const PUMP_SELL_V2_DISCRIMINATOR: [u8; 8] = [93, 246, 130, 60, 231, 233, 64, 178];
pub const PUMP_FUN_CREATE_IX_DISCRIMINATOR: &[u8] = &[24, 30, 200, 40, 5, 28, 7, 119];
pub const INITIAL_VIRTUAL_SOL_RESERVES: u64 = 30_000_000_000;
pub const INITIAL_VIRTUAL_TOKEN_RESERVES: u64 = 1_073_000_000_000_000;
pub const TOKEN_TOTAL_SUPPLY: u64 = 1_000_000_000_000_000;

// Volume accumulator seeds
pub const GLOBAL_VOLUME_ACCUMULATOR_SEED: &[u8] = b"global_volume_accumulator";
pub const USER_VOLUME_ACCUMULATOR_SEED: &[u8] = b"user_volume_accumulator";
pub const EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";
pub const CREATOR_VAULT_SEED: &[u8] = b"creator-vault";
pub const SHARING_CONFIG_SEED: &[u8] = b"sharing-config";
pub const FEE_CONFIG_SEED: &[u8] = b"fee_config";

pub const PUMP_NORMAL_FEE_RECIPIENTS: [&str; 8] = [
    "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV",
    "7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ",
    "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX",
    "9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz",
    "AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY",
    "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
    "FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz",
    "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP",
];

pub const PUMP_RESERVED_FEE_RECIPIENTS: [&str; 8] = [
    "GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS",
    "4budycTjhs9fD6xw62VBducVTNgMgJJ5BgtKq7mAZwn6",
    "8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR",
    "4UQeTP1T39KZ9Sfxzo3WR5skgsaP6NZa87BAkuazLEKH",
    "8sNeir4QsLsJdYpc9RZacohhK1Y5FLU3nC5LXgYB4aa6",
    "Fh9HmeLNUMVCvejxCtCL2DbYaRyBFVJ5xrWkLnMH6fdk",
    "463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq",
    "6AUH3WEHucYZyC61hqpqYUWVto5qA5hjHuNQ32GNnNxA",
];

pub const PUMP_BUYBACK_FEE_RECIPIENTS: [&str; 8] = [
    "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
    "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
    "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
    "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
    "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
    "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
    "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
    "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
];


#[derive(Clone)]
pub struct Pump {
    pub rpc_nonblocking_client: Arc<anchor_client::solana_client::nonblocking::rpc_client::RpcClient>,
    pub keypair: Arc<Keypair>,
    pub rpc_client: Option<Arc<anchor_client::solana_client::rpc_client::RpcClient>>,
}

impl Pump {
    pub fn new(
        rpc_nonblocking_client: Arc<anchor_client::solana_client::nonblocking::rpc_client::RpcClient>,
        rpc_client: Arc<anchor_client::solana_client::rpc_client::RpcClient>,
        keypair: Arc<Keypair>,
    ) -> Self {
        // Initialize caches on first use
        tokio::spawn(init_caches());
        
        Self {
            rpc_nonblocking_client,
            keypair,
            rpc_client: Some(rpc_client),
        }
    }

    async fn check_token_account_cache(&self, account: Pubkey) -> bool {
        WALLET_TOKEN_ACCOUNTS.contains(&account)
    }

    async fn cache_token_account(&self, account: Pubkey) {
        WALLET_TOKEN_ACCOUNTS.insert(account);
    }
    
    /// Helper method to determine the correct token program for a mint
    async fn get_token_program(&self, mint: &Pubkey) -> Result<Pubkey> {
        if let Some(rpc_client) = &self.rpc_client {
            match rpc_client.get_account(mint) {
                Ok(account) => {
                    if account.owner.to_string() == TOKEN_2022_PROGRAM {
                        Ok(Pubkey::from_str(TOKEN_2022_PROGRAM)?)
                    } else {
                        Ok(Pubkey::from_str(TOKEN_PROGRAM)?)
                    }
                },
                Err(_) => {
                    // Default to TOKEN_PROGRAM if we can't fetch the account
                    Ok(Pubkey::from_str(TOKEN_PROGRAM)?)
                }
            }
        } else {
            // Default to TOKEN_PROGRAM if no RPC client
            Ok(Pubkey::from_str(TOKEN_PROGRAM)?)
        }
    }

    pub async fn get_token_price(&self, mint_str: &str) -> Result<f64> {
        // For PumpFun, we'll use a fallback method since we don't have trade_info here
        // This method is mainly used for standalone price queries
        let mint = Pubkey::from_str(mint_str).map_err(|_| anyhow!("Invalid mint address"))?;
        let pump_program = Pubkey::from_str(PUMP_FUN_PROGRAM)?;
        
        // Get the bonding curve account info as fallback
        let (_, _, bonding_curve_reserves) = get_bonding_curve_account(
            self.rpc_client.clone().unwrap(), 
            mint, 
            pump_program
        ).await?;
        
        // Calculate price using the virtual reserves with consistent scaling
        let virtual_sol_reserves = bonding_curve_reserves.virtual_sol_reserves as f64;
        let virtual_token_reserves = bonding_curve_reserves.virtual_token_reserves as f64;
        
        // Price formula: (virtual_sol_reserves * 1_000_000_000) / virtual_token_reserves
        // This matches the scaling used in transaction_parser.rs for consistency
        let price = if virtual_token_reserves > 0.0 {
            (virtual_sol_reserves * 1_000_000_000.0) / virtual_token_reserves
        } else {
            0.0
        };
        
            Ok(price)
    }

    async fn fetch_bonding_curve_state(
        &self,
        mint: &Pubkey,
        pump_program: &Pubkey,
    ) -> Result<(Pubkey, BondingCurveAccount)> {
        let rpc_client = self
            .rpc_client
            .as_ref()
            .ok_or_else(|| anyhow!("RPC client not initialized"))?;
        let bonding_curve = get_pda(mint, pump_program)?;
        let account_data = rpc_client.get_account_data(&bonding_curve)?;
        let bonding_curve_account = decode_bonding_curve_account(&account_data)
            .map_err(|e| anyhow!("Failed to decode bonding curve {}: {}", bonding_curve, e))?;

        Ok((bonding_curve, bonding_curve_account))
    }

    pub async fn get_curve_state_for_mint(
        &self,
        mint: &Pubkey,
    ) -> Result<(Pubkey, BondingCurveAccount)> {
        let pump_program = Pubkey::from_str(PUMP_FUN_PROGRAM)?;
        self.fetch_bonding_curve_state(mint, &pump_program).await
    }

    pub async fn build_buy_v2_from_mint(
        &self,
        mint: Pubkey,
        amount_sol: f64,
        slippage_bps: u64,
    ) -> Result<(Arc<Keypair>, Vec<Instruction>, f64)> {
        let owner = self.keypair.pubkey();
        let logger = Logger::new("[PUMPFUN-BUY-V2] => ".blue().to_string());
        let pump_program = Pubkey::from_str(PUMP_FUN_PROGRAM)?;
        let token_program_id = self.get_token_program(&mint).await?;
        let quote_mint = spl_token::native_mint::ID;
        let quote_token_program = Pubkey::from_str(TOKEN_PROGRAM)?;
        let (bonding_curve, curve_state) = self.fetch_bonding_curve_state(&mint, &pump_program).await?;
        if curve_state.complete {
            return Err(anyhow!("Bonding curve complete; use PumpSwap"));
        }
        let associated_base_user =
            get_associated_token_address_with_program_id(&owner, &mint, &token_program_id);
        let associated_quote_user =
            get_associated_token_address_with_program_id(&owner, &quote_mint, &quote_token_program);

        let mut instructions = Vec::new();
        if !self.check_token_account_cache(associated_base_user).await {
            instructions.push(create_associated_token_account_idempotent(
                &owner,
                &owner,
                &mint,
                &token_program_id,
            ));
            self.cache_token_account(associated_base_user).await;
        }
        if !self.check_token_account_cache(associated_quote_user).await {
            instructions.push(create_associated_token_account_idempotent(
                &owner,
                &owner,
                &quote_mint,
                &quote_token_program,
            ));
            self.cache_token_account(associated_quote_user).await;
        }

        let amount_lamports = ui_amount_to_amount(amount_sol, spl_token::native_mint::DECIMALS);
        let token_amount = Self::calculate_buy_token_amount(
            amount_lamports,
            curve_state.virtual_sol_reserves,
            curve_state.virtual_token_reserves,
        );
        if token_amount == 0 {
            return Err(anyhow!("Calculated buy amount is zero"));
        }

        let max_sol_cost = max_amount_with_slippage(amount_lamports, slippage_bps);
        let account_metas = build_pump_v2_accounts(
            &mint,
            &owner,
            &token_program_id,
            &quote_mint,
            &quote_token_program,
            &pump_program,
            &bonding_curve,
            &curve_state,
            true,
        )?;
        let swap_instruction = Instruction {
            program_id: pump_program,
            accounts: account_metas,
            data: build_pump_v2_data(PUMP_BUY_V2_DISCRIMINATOR, token_amount, max_sol_cost),
        };
        instructions.push(swap_instruction);

        let token_price = Self::calculate_price_from_virtual_reserves(
            curve_state.virtual_sol_reserves,
            curve_state.virtual_token_reserves,
        ) / 1_000_000_000.0;
        logger.log(format!(
            "Prepared buy_v2 for mint {} with {} SOL, token amount {}, max quote {}",
            mint, amount_sol, token_amount, max_sol_cost
        ));

        Ok((self.keypair.clone(), instructions, token_price))
    }

    /// Calculate token amount out for buy using virtual reserves
    pub fn calculate_buy_token_amount(
        sol_amount_in: u64,
        virtual_sol_reserves: u64,
        virtual_token_reserves: u64,
    ) -> u64 {
        if sol_amount_in == 0 || virtual_sol_reserves == 0 || virtual_token_reserves == 0 {
            return 0;
        }
        
        // PumpFun bonding curve formula for buy:
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

    /// Calculate SOL amount out for sell using virtual reserves
    pub fn calculate_sell_sol_amount(
        token_amount_in: u64,
        virtual_sol_reserves: u64,
        virtual_token_reserves: u64,
    ) -> u64 {
        if token_amount_in == 0 || virtual_sol_reserves == 0 || virtual_token_reserves == 0 {
            return 0;
        }
        
        // PumpFun bonding curve formula for sell:
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

    /// Calculate price using virtual reserves with consistent scaling
    pub fn calculate_price_from_virtual_reserves(
        virtual_sol_reserves: u64,
        virtual_token_reserves: u64,
    ) -> f64 {
        if virtual_token_reserves == 0 {
            return 0.0;
        }
        
        // Price = (virtual_sol_reserves * 1_000_000_000) / virtual_token_reserves  
        // This matches the scaling used in transaction_parser.rs for consistency
        ((virtual_sol_reserves as f64) * 1_000_000_000.0) / (virtual_token_reserves as f64)
    }

    // Update the build_swap_from_parsed_data method
    pub async fn build_swap_from_parsed_data(
        &self,
        trade_info: &crate::engine::transaction_parser::TradeInfoFromToken,
        swap_config: SwapConfig,
    ) -> Result<(Arc<Keypair>, Vec<Instruction>, f64)> {
        let started_time = Instant::now();
        let _logger = Logger::new("[PUMPFUN-SWAP-FROM-PARSED] => ".blue().to_string());
        _logger.log(format!("Building PumpFun swap from parsed transaction data"));
        
        // Basic validation - ensure we have a PumpFun transaction
        if trade_info.dex_type != crate::engine::transaction_parser::DexType::PumpFun {
            println!("Invalid transaction type, expected PumpFun ::{:?}", trade_info.dex_type);
            // return Err(anyhow!("Invalid transaction type, expected PumpFun"));
        }
        
        // Extract the essential data
        let mint_str = &trade_info.mint;
        let owner = self.keypair.pubkey();
        let mint = Pubkey::from_str(mint_str)?;
        
        // Get the correct token program for the mint
        let token_program_id = self.get_token_program(&mint).await.unwrap_or(Pubkey::from_str(TOKEN_PROGRAM)?);
        let native_mint = spl_token::native_mint::ID;
        let quote_token_program = Pubkey::from_str(TOKEN_PROGRAM)?;
        let pump_program = Pubkey::from_str(PUMP_FUN_PROGRAM)?;
        let (bonding_curve, curve_state) = self.fetch_bonding_curve_state(&mint, &pump_program).await?;

        // Use trade_info.price directly instead of fetching bonding curve info
        _logger.log("Using trade_info.price for calculations".to_string());

        // Get volume accumulator PDAs
        // Determine if this is a buy or sell operation
        let (token_in, token_out, _pump_method) = match swap_config.swap_direction {
            SwapDirection::Buy => (native_mint, mint, PUMP_BUY_METHOD),
            SwapDirection::Sell => (mint, native_mint, PUMP_SELL_METHOD),
        };
        
        // Calculate price using virtual reserves from trade_info
        let price_in_sol = Self::calculate_price_from_virtual_reserves(
            trade_info.virtual_sol_reserves,
            trade_info.virtual_token_reserves,
        );
        _logger.log(format!("Calculated price from virtual reserves: {} (scaled) -> {} SOL (Virtual SOL: {}, Virtual Tokens: {})", 
            price_in_sol, price_in_sol / 1_000_000_000.0, trade_info.virtual_sol_reserves, trade_info.virtual_token_reserves));
        // Use slippage directly as basis points (already u64)
        let slippage_bps = swap_config.slippage;
        // Create instructions as needed
        let mut create_instruction = None;
        let mut close_instruction = None;
        let mut additional_instructions = Vec::new(); // For multiple account creation instructions
        
        // Handle token accounts based on direction (buy or sell)
        let in_ata = get_associated_token_address_with_program_id(
            &owner,
            &token_in,
            &if swap_config.swap_direction == SwapDirection::Buy {
                quote_token_program
            } else {
                token_program_id
            },
        );
        let out_ata = get_associated_token_address_with_program_id(
            &owner,
            &token_out,
            &if swap_config.swap_direction == SwapDirection::Buy {
                token_program_id
            } else {
                quote_token_program
            },
        );
        // Check if accounts exist and create if needed
        if swap_config.swap_direction == SwapDirection::Buy {
            // Check if token account exists using cache first
            if !self.check_token_account_cache(out_ata).await {
                create_instruction = Some(create_associated_token_account_idempotent(
                    &owner,
                    &owner,
                    &token_out,
                    &token_program_id,
                ));
                // Cache the new account
                self.cache_token_account(out_ata).await;
            }
            
            // Check if WSOL account exists for buying (WSOL always uses TOKEN_PROGRAM)
            let wsol_ata = get_associated_token_address_with_program_id(
                &owner,
                &token_in,
                &quote_token_program,
            );
            if !self.check_token_account_cache(wsol_ata).await {
                let wsol_create_instruction = create_associated_token_account_idempotent(
                    &owner,
                    &owner,
                    &token_in,
                    &quote_token_program,
                );
                additional_instructions.push(wsol_create_instruction);
                // Cache the new WSOL account
                self.cache_token_account(wsol_ata).await;
            }
        } else {
            // For sell, check if we have tokens to sell using cache first
            if !self.check_token_account_cache(in_ata).await {
                return Err(anyhow!("Token ATA does not exist, cannot sell"));
            }
            
            // For sell transactions, determine if it's a full sell
            if swap_config.in_type == SwapInType::Pct && swap_config.amount_in >= 1.0 {
                // Close ATA for full sells
                close_instruction = Some(spl_token::instruction::close_account(
                    &token_program_id,
                    &in_ata,
                    &owner,
                    &owner,
                    &[&owner],
                )?);
            }
        }
        // Try to use parsed max_sol_cost or calculate from 
        //TODO: add rate copy 
        //TODO: currently fixed copy from token_amount in env
        let _is_use_copy_rate=false;
        //let copy_rate=10; // copy percent

        // Calculate token amount and threshold based on operation type and parsed data
        let (token_amount, sol_amount_threshold, input_accounts) = match swap_config.swap_direction {
            SwapDirection::Buy => {
                let amount_specified = ui_amount_to_amount(swap_config.amount_in, spl_token::native_mint::DECIMALS);
                let max_sol_cost = max_amount_with_slippage(amount_specified, slippage_bps);
                
                // Use virtual reserves from trade_info for accurate calculation
                let tokens_out = Self::calculate_buy_token_amount(
                    amount_specified,
                    trade_info.virtual_sol_reserves,
                    trade_info.virtual_token_reserves,
                );
                
                _logger.log(format!("Buy calculation - SOL in: {}, Tokens out: {}, Virtual SOL: {}, Virtual Tokens: {}", 
                    amount_specified, tokens_out, trade_info.virtual_sol_reserves, trade_info.virtual_token_reserves));
                
                (
                    tokens_out,
                    max_sol_cost,
                    build_pump_v2_accounts(
                        &mint,
                        &owner,
                        &token_program_id,
                        &native_mint,
                        &quote_token_program,
                        &pump_program,
                        &bonding_curve,
                        &curve_state,
                        true,
                    )?
                )
            },
            SwapDirection::Sell => {
                // NOTE: For selling, this method should not be called directly.
                // Use build_swap_from_parsed_data_with_balance instead.
                return Err(anyhow!("For selling, use build_swap_from_parsed_data_with_balance method with cached balance"));
            }
        };

        // Build swap instruction
        let swap_instruction = Instruction {
            program_id: pump_program,
            accounts: input_accounts,
            data: build_pump_v2_data(PUMP_BUY_V2_DISCRIMINATOR, token_amount, sol_amount_threshold),
        };
        
        // Combine all instructions
        let mut instructions = vec![];
        if let Some(create_instruction) = create_instruction {
            instructions.push(create_instruction);
        }
        for instruction in additional_instructions {
            instructions.push(instruction);
        }
        if token_amount > 0 {
            instructions.push(swap_instruction);
        }
        if let Some(close_instruction) = close_instruction {
            instructions.push(close_instruction);
        }
        
        // Validate we have instructions
        if instructions.is_empty() {
            return Err(anyhow!("Instructions is empty, no txn required."));
        }
        
        // Use price from trade_info directly - convert back to unscaled for consistency with external usage
        let token_price = price_in_sol / 1_000_000_000.0;
        println!("time taken for build_swap_from_parsed_data: {:?}", started_time.elapsed());
        // Return the keypair, instructions, and the token price (unscaled f64)
        Ok((self.keypair.clone(), instructions, token_price))
    }

    /// Build swap transaction with cached token balance (for selling without RPC calls)
    pub async fn build_swap_from_parsed_data_with_balance(
        &self,
        trade_info: &crate::engine::transaction_parser::TradeInfoFromToken,
        swap_config: SwapConfig,
        cached_balance: Option<(u64, u8)>, // (raw_balance, decimals) - None for buying
    ) -> Result<(Arc<Keypair>, Vec<Instruction>, f64)> {
        let started_time = Instant::now();
        let _logger = Logger::new("[PUMPFUN-SWAP-WITH-BALANCE] => ".blue().to_string());
        _logger.log(format!("Building PumpFun swap with cached balance"));
        
        // Basic validation - ensure we have a PumpFun transaction
        if trade_info.dex_type != crate::engine::transaction_parser::DexType::PumpFun {
            println!("Invalid transaction type, expected PumpFun ::{:?}", trade_info.dex_type);
        }
        
        // Extract the essential data
        let mint_str = &trade_info.mint;
        let owner = self.keypair.pubkey();
        let mint = Pubkey::from_str(mint_str)?;
        let token_program_id = self.get_token_program(&mint).await.unwrap_or(Pubkey::from_str(TOKEN_PROGRAM)?);
        let native_mint = spl_token::native_mint::ID;
        let quote_token_program = Pubkey::from_str(TOKEN_PROGRAM)?;
        let pump_program = Pubkey::from_str(PUMP_FUN_PROGRAM)?;
        let (bonding_curve, curve_state) = self.fetch_bonding_curve_state(&mint, &pump_program).await?;

        // Determine if this is a buy or sell operation
        let (token_in, token_out, _pump_method) = match swap_config.swap_direction {
            SwapDirection::Buy => (native_mint, mint, PUMP_BUY_METHOD),
            SwapDirection::Sell => (mint, native_mint, PUMP_SELL_METHOD),
        };
        
        // Calculate price using virtual reserves from trade_info
        let price_in_sol = Self::calculate_price_from_virtual_reserves(
            trade_info.virtual_sol_reserves,
            trade_info.virtual_token_reserves,
        );
        _logger.log(format!("Calculated price from virtual reserves: {} (scaled) -> {} SOL", 
            price_in_sol, price_in_sol / 1_000_000_000.0));

        let slippage_bps = swap_config.slippage;
        
        // Create instructions as needed
        let mut create_instruction = None;
        let mut close_instruction = None;
        let mut additional_instructions = Vec::new();
        
        // Handle token accounts based on direction
        let in_ata = get_associated_token_address_with_program_id(
            &owner,
            &token_in,
            &if swap_config.swap_direction == SwapDirection::Buy {
                quote_token_program
            } else {
                token_program_id
            },
        );
        let out_ata = get_associated_token_address_with_program_id(
            &owner,
            &token_out,
            &if swap_config.swap_direction == SwapDirection::Buy {
                token_program_id
            } else {
                quote_token_program
            },
        );
        
        if swap_config.swap_direction == SwapDirection::Buy {
            // Check if token account exists using cache first
            if !self.check_token_account_cache(out_ata).await {
                create_instruction = Some(create_associated_token_account_idempotent(
                    &owner,
                    &owner,
                    &token_out,
                    &token_program_id,
                ));
                // Cache the new account
                self.cache_token_account(out_ata).await;
            }
            if !self.check_token_account_cache(in_ata).await {
                additional_instructions.push(create_associated_token_account_idempotent(
                    &owner,
                    &owner,
                    &token_in,
                    &quote_token_program,
                ));
                self.cache_token_account(in_ata).await;
            }
        } else {
            // For sell, verify we have the cached balance
            if cached_balance.is_none() {
                return Err(anyhow!("Cached balance required for selling"));
            }
            
            // For sell transactions, determine if it's a full sell
            if swap_config.in_type == SwapInType::Pct && swap_config.amount_in >= 1.0 {
                close_instruction = Some(spl_token::instruction::close_account(
                    &token_program_id,
                    &in_ata,
                    &owner,
                    &owner,
                    &[&owner],
                )?);
            }
        }

        // Calculate token amount and threshold based on operation type
        let (token_amount, sol_amount_threshold, input_accounts) = match swap_config.swap_direction {
            SwapDirection::Buy => {
                let amount_specified = ui_amount_to_amount(swap_config.amount_in, spl_token::native_mint::DECIMALS);
                let max_sol_cost = max_amount_with_slippage(amount_specified, slippage_bps);
                
                // Use virtual reserves from trade_info for accurate calculation
                let tokens_out = Self::calculate_buy_token_amount(
                    amount_specified,
                    trade_info.virtual_sol_reserves,
                    trade_info.virtual_token_reserves,
                );
                
                _logger.log(format!("Buy calculation - SOL in: {}, Tokens out: {}", amount_specified, tokens_out));
                
                (
                    tokens_out,
                    max_sol_cost,
                    build_pump_v2_accounts(
                        &mint,
                        &owner,
                        &token_program_id,
                        &native_mint,
                        &quote_token_program,
                        &pump_program,
                        &bonding_curve,
                        &curve_state,
                        true,
                    )?
                )
            },
            SwapDirection::Sell => {
                // Use cached balance instead of RPC call
                let (balance_raw, token_decimals) = cached_balance.unwrap();
                
                // Calculate amount to sell from cached balance
                let amount = match swap_config.in_type {
                    SwapInType::Qty => {
                        ui_amount_to_amount(swap_config.amount_in, token_decimals)
                    },
                    SwapInType::Pct => {
                        let amount_in_pct = swap_config.amount_in.min(1.0);
                        if amount_in_pct == 1.0 {
                            balance_raw
                        } else {
                            (amount_in_pct * 100.0) as u64 * balance_raw / 100
                        }
                    }
                };
                
                // Validate amount
                if amount == 0 {
                    return Err(anyhow!("Amount is zero, cannot sell"));
                }
                
                if amount > balance_raw {
                    return Err(anyhow!("Insufficient balance: trying to sell {} but only have {}", amount, balance_raw));
                }
                
                // Calculate expected SOL output using virtual reserves
                let expected_sol_out = Self::calculate_sell_sol_amount(
                    amount,
                    trade_info.virtual_sol_reserves,
                    trade_info.virtual_token_reserves,
                );
                
                // Apply slippage
                let slippage_factor = 1.0 - (slippage_bps as f64 / 10000.0);
                let min_sol_output = (expected_sol_out as f64 * slippage_factor) as u64;
                
                _logger.log(format!("Sell calculation - Tokens in: {} (from cached balance: {}), Expected SOL out: {}, Min SOL out: {}", 
                    amount, balance_raw, expected_sol_out, min_sol_output));
                
                (
                    amount,
                    min_sol_output,
                    build_pump_v2_accounts(
                        &mint,
                        &owner,
                        &token_program_id,
                        &native_mint,
                        &quote_token_program,
                        &pump_program,
                        &bonding_curve,
                        &curve_state,
                        false,
                    )?
                )
            }
        };

        let ix_discriminator = if swap_config.swap_direction == SwapDirection::Buy {
            PUMP_BUY_V2_DISCRIMINATOR
        } else {
            PUMP_SELL_V2_DISCRIMINATOR
        };
        let swap_instruction = Instruction {
            program_id: pump_program,
            accounts: input_accounts,
            data: build_pump_v2_data(ix_discriminator, token_amount, sol_amount_threshold),
        };
        
        // Combine all instructions
        let mut instructions = vec![];
        if let Some(create_instruction) = create_instruction {
            instructions.push(create_instruction);
        }
        for instruction in additional_instructions {
            instructions.push(instruction);
        }
        if token_amount > 0 {
            instructions.push(swap_instruction);
        }
        if let Some(close_instruction) = close_instruction {
            instructions.push(close_instruction);
        }
        
        // Validate we have instructions
        if instructions.is_empty() {
            return Err(anyhow!("Instructions is empty, no txn required."));
        }
        
        // Use price from trade_info directly - convert back to unscaled for consistency
        let token_price = price_in_sol / 1_000_000_000.0;
        println!("time taken for build_swap_from_parsed_data_with_balance: {:?}", started_time.elapsed());
        
        Ok((self.keypair.clone(), instructions, token_price))
    }
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RaydiumInfo {
    pub base: f64,
    pub quote: f64,
    pub price: f64,
}
#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PumpInfo {
    pub mint: String,
    pub bonding_curve: String,
    pub associated_bonding_curve: String,
    pub raydium_pool: Option<String>,
    pub raydium_info: Option<RaydiumInfo>,
    pub complete: bool,
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub total_supply: u64,
}

#[derive(Debug, BorshSerialize, BorshDeserialize)]
pub struct BondingCurveAccount {
    pub discriminator: u64,
    pub virtual_token_reserves: u64,
    pub virtual_sol_reserves: u64,
    pub real_token_reserves: u64,
    pub real_sol_reserves: u64,
    pub token_total_supply: u64,
    pub complete: bool,
    pub creator: Pubkey,
    pub is_mayhem_mode: bool,
    pub is_cashback_coin: bool,
}

#[derive(Debug, BorshSerialize, BorshDeserialize)]
pub struct BondingCurveReserves {
    pub virtual_token_reserves: u64,
    pub virtual_sol_reserves: u64,
}

#[derive(Debug, BorshSerialize, BorshDeserialize)]
pub struct GlobalVolumeAccumulator {
    pub start_time: i64,
    pub end_time: i64,
    pub seconds_in_a_day: i64,
    pub mint: Pubkey,
    pub total_token_supply: [u64; 30],
    pub sol_volumes: [u64; 30],
}

#[derive(Debug, BorshSerialize, BorshDeserialize)]
pub struct UserVolumeAccumulator {
    pub user: Pubkey,
    pub needs_claim: bool,
    pub total_unclaimed_tokens: u64,
    pub total_claimed_tokens: u64,
    pub current_sol_volume: u64,
    pub last_update_timestamp: i64,
    pub has_total_claimed_tokens: bool,
}

pub fn get_bonding_curve_account_by_calc(
    bonding_curve_info: BondingCurveInfo,
    mint: Pubkey,
) -> (Pubkey, Pubkey, BondingCurveReserves) {
    let bonding_curve = bonding_curve_info.bonding_curve;
    let associated_bonding_curve = get_associated_token_address(&bonding_curve, &mint);
    
    let bonding_curve_reserves = BondingCurveReserves 
        { 
            virtual_token_reserves: bonding_curve_info.new_virtual_token_reserve, 
            virtual_sol_reserves: bonding_curve_info.new_virtual_sol_reserve,
        };

    (
        bonding_curve,
        associated_bonding_curve,
        bonding_curve_reserves,
    )
}

pub async fn get_bonding_curve_account(
    rpc_client: Arc<anchor_client::solana_client::rpc_client::RpcClient>,
    mint: Pubkey,
    pump_program: Pubkey,
) -> Result<(Pubkey, Pubkey, BondingCurveReserves)> {
    let bonding_curve = get_pda(&mint, &pump_program)?;
    let associated_bonding_curve = get_associated_token_address(&bonding_curve, &mint);
    
    // Get account data and token balance sequentially since RpcClient is synchronous
    let bonding_curve_data_result = rpc_client.get_account_data(&bonding_curve);
    let token_balance_result = rpc_client.get_token_account_balance(&associated_bonding_curve);
    
    let bonding_curve_reserves = match bonding_curve_data_result {
        Ok(bonding_curve_data) => {
            match decode_bonding_curve_account(&bonding_curve_data) {
                Ok(bonding_curve_account) => BondingCurveReserves {
                    virtual_token_reserves: bonding_curve_account.virtual_token_reserves,
                    virtual_sol_reserves: bonding_curve_account.virtual_sol_reserves 
                },
                Err(_) => {
                    // Fallback to direct balance checks
                    let bonding_curve_sol_balance = rpc_client.get_balance(&bonding_curve).unwrap_or(0);
                    let token_balance = match &token_balance_result {
                        Ok(balance) => {
                            match balance.ui_amount {
                                Some(amount) => (amount * (10f64.powf(balance.decimals as f64))) as u64,
                                None => 0,
                            }
                        },
                        Err(_) => 0
                    };
                    
                    BondingCurveReserves {
                        virtual_token_reserves: token_balance,
                        virtual_sol_reserves: bonding_curve_sol_balance,
                    }
                }
            }
        },
        Err(_) => {
            // Fallback to direct balance checks
            let bonding_curve_sol_balance = rpc_client.get_balance(&bonding_curve).unwrap_or(0);
            let token_balance = match &token_balance_result {
                Ok(balance) => {
                    match balance.ui_amount {
                        Some(amount) => (amount * (10f64.powf(balance.decimals as f64))) as u64,
                        None => 0,
                    }
                },
                Err(_) => 0
            };
            
            BondingCurveReserves {
                virtual_token_reserves: token_balance,
                virtual_sol_reserves: bonding_curve_sol_balance,
            }
        }
    };

    Ok((
        bonding_curve,
        associated_bonding_curve,
        bonding_curve_reserves,
    ))
}

fn max_amount_with_slippage(input_amount: u64, slippage_bps: u64) -> u64 {
    input_amount
        .checked_mul(slippage_bps.checked_add(TEN_THOUSAND).unwrap())
        .unwrap()
        .checked_div(TEN_THOUSAND)
        .unwrap()
}

pub fn get_pda(mint: &Pubkey, program_id: &Pubkey ) -> Result<Pubkey> {
    let seeds = [b"bonding-curve".as_ref(), mint.as_ref()];
    let (bonding_curve, _bump) = Pubkey::find_program_address(&seeds, program_id);
    Ok(bonding_curve)
}

/// Get the global volume accumulator PDA
pub fn get_global_volume_accumulator_pda(program_id: &Pubkey) -> Result<Pubkey> {
    let seeds = [GLOBAL_VOLUME_ACCUMULATOR_SEED];
    let (pda, _bump) = Pubkey::find_program_address(&seeds, program_id);
    Ok(pda)
}

/// Get the user volume accumulator PDA for a specific user
pub fn get_user_volume_accumulator_pda(user: &Pubkey, program_id: &Pubkey) -> Result<Pubkey> {
    let seeds = [USER_VOLUME_ACCUMULATOR_SEED, user.as_ref()];
    let (pda, _bump) = Pubkey::find_program_address(&seeds, program_id);
    Ok(pda)
}

fn random_recipient(addresses: &[&str]) -> Result<Pubkey> {
    let mut rng = thread_rng();
    let recipient = addresses
        .choose(&mut rng)
        .ok_or_else(|| anyhow!("No fee recipients configured"))?;
    Ok(Pubkey::from_str(recipient)?)
}

fn build_pump_v2_data(discriminator: [u8; 8], amount: u64, threshold: u64) -> Vec<u8> {
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&threshold.to_le_bytes());
    data
}

fn get_creator_vault_pda(creator: &Pubkey, program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[CREATOR_VAULT_SEED, creator.as_ref()], program_id).0
}

fn get_event_authority_pda(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[EVENT_AUTHORITY_SEED], program_id).0
}

fn get_sharing_config_pda(mint: &Pubkey, fee_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[SHARING_CONFIG_SEED, mint.as_ref()], fee_program).0
}

fn get_fee_config_pda(pump_program: &Pubkey, fee_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[FEE_CONFIG_SEED, pump_program.as_ref()], fee_program).0
}

fn build_pump_v2_accounts(
    mint: &Pubkey,
    owner: &Pubkey,
    base_token_program: &Pubkey,
    quote_mint: &Pubkey,
    quote_token_program: &Pubkey,
    pump_program: &Pubkey,
    bonding_curve: &Pubkey,
    curve_state: &BondingCurveAccount,
    include_global_volume_accumulator: bool,
) -> Result<Vec<AccountMeta>> {
    let fee_program = Pubkey::from_str(PUMP_FUN_FEE_PROGRAM)?;
    let fee_recipient = if curve_state.is_mayhem_mode {
        random_recipient(&PUMP_RESERVED_FEE_RECIPIENTS)?
    } else {
        random_recipient(&PUMP_NORMAL_FEE_RECIPIENTS)?
    };
    let buyback_fee_recipient = random_recipient(&PUMP_BUYBACK_FEE_RECIPIENTS)?;

    let associated_quote_fee_recipient = get_associated_token_address_with_program_id(
        &fee_recipient,
        quote_mint,
        quote_token_program,
    );
    let associated_quote_buyback_fee_recipient = get_associated_token_address_with_program_id(
        &buyback_fee_recipient,
        quote_mint,
        quote_token_program,
    );
    let associated_base_bonding_curve = get_associated_token_address_with_program_id(
        bonding_curve,
        mint,
        base_token_program,
    );
    let associated_quote_bonding_curve = get_associated_token_address_with_program_id(
        bonding_curve,
        quote_mint,
        quote_token_program,
    );
    let associated_base_user = get_associated_token_address_with_program_id(
        owner,
        mint,
        base_token_program,
    );
    let associated_quote_user = get_associated_token_address_with_program_id(
        owner,
        quote_mint,
        quote_token_program,
    );
    let creator_vault = get_creator_vault_pda(&curve_state.creator, pump_program);
    let associated_creator_vault = get_associated_token_address_with_program_id(
        &creator_vault,
        quote_mint,
        quote_token_program,
    );
    let sharing_config = get_sharing_config_pda(mint, &fee_program);
    let global_volume_accumulator = get_global_volume_accumulator_pda(pump_program)?;
    let user_volume_accumulator = get_user_volume_accumulator_pda(owner, pump_program)?;
    let associated_user_volume_accumulator = get_associated_token_address_with_program_id(
        &user_volume_accumulator,
        quote_mint,
        quote_token_program,
    );
    let fee_config = get_fee_config_pda(pump_program, &fee_program);
    let event_authority = get_event_authority_pda(pump_program);

    let mut accounts = vec![
        AccountMeta::new_readonly(Pubkey::from_str(PUMP_GLOBAL)?, false),
        AccountMeta::new_readonly(*mint, false),
        AccountMeta::new_readonly(*quote_mint, false),
        AccountMeta::new_readonly(*base_token_program, false),
        AccountMeta::new_readonly(*quote_token_program, false),
        AccountMeta::new_readonly(Pubkey::from_str(ASSOCIATED_TOKEN_PROGRAM)?, false),
        AccountMeta::new(fee_recipient, false),
        AccountMeta::new(associated_quote_fee_recipient, false),
        AccountMeta::new(buyback_fee_recipient, false),
        AccountMeta::new(associated_quote_buyback_fee_recipient, false),
        AccountMeta::new(*bonding_curve, false),
        AccountMeta::new(associated_base_bonding_curve, false),
        AccountMeta::new(associated_quote_bonding_curve, false),
        AccountMeta::new(*owner, true),
        AccountMeta::new(associated_base_user, false),
        AccountMeta::new(associated_quote_user, false),
        AccountMeta::new(creator_vault, false),
        AccountMeta::new(associated_creator_vault, false),
        AccountMeta::new_readonly(sharing_config, false),
    ];

    if include_global_volume_accumulator {
        accounts.push(AccountMeta::new_readonly(global_volume_accumulator, false));
    }

    accounts.extend([
        AccountMeta::new(user_volume_accumulator, false),
        AccountMeta::new(associated_user_volume_accumulator, false),
        AccountMeta::new_readonly(fee_config, false),
        AccountMeta::new_readonly(fee_program, false),
        AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new_readonly(event_authority, false),
        AccountMeta::new_readonly(*pump_program, false),
    ]);

    Ok(accounts)
}
