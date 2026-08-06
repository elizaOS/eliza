use std::sync::Arc;
use std::str::FromStr;
use anyhow::{anyhow, Result};
use anchor_client::solana_sdk::{hash::Hash, instruction::Instruction, pubkey::Pubkey, signature::{Keypair, Signature}};
use colored::Colorize;
use spl_associated_token_account::get_associated_token_address;
use spl_token;
use solana_program_pack::Pack;
use anchor_client::solana_sdk::transaction::{Transaction, VersionedTransaction};
use anchor_client::solana_sdk::signature::Signer;
use crate::common::{
    config::{AppState, SwapConfig},
    logger::Logger,
};
use crate::engine::transaction_parser::{TradeInfoFromToken, DexType};
use crate::engine::swap::{SwapDirection, SwapProtocol, SwapInType};
use crate::dex::pump_fun::Pump;
use crate::dex::pump_swap::PumpSwap;
use crate::services::balance_manager::BalanceManager;
use crate::services::risk_management::{
    JupiterQuoteResponse,
    JupiterSwapRequest,
    JupiterSwapResponse,
    PrioritizationFeeLamports,
    PriorityLevelWithMaxLamports,
    JUPITER_API_URL,
};

/// Token account information for bulk selling
#[derive(Debug, Clone)]
pub struct WalletTokenInfo {
    pub mint: String,
    pub account_pubkey: Pubkey,
    pub amount: f64,
    pub amount_raw: u64,
    pub decimals: u8,
}

const SOL_MINT: &str = "So11111111111111111111111111111111111111112";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
/// Simple selling engine for basic buy/sell operations
#[derive(Clone)]
pub struct SimpleSellingEngine {
    app_state: Arc<AppState>,
    swap_config: Arc<SwapConfig>,
    transaction_landing_mode: crate::common::config::TransactionLandingMode,
    logger: Logger,
}

impl SimpleSellingEngine {
    pub fn new(
        app_state: Arc<AppState>,
        swap_config: Arc<SwapConfig>,
        transaction_landing_mode: crate::common::config::TransactionLandingMode,
    ) -> Self {
        Self {
            app_state,
            swap_config,
            transaction_landing_mode,
            logger: Logger::new("[SIMPLE-SELLING] => ".yellow().to_string()),
        }
    }
    
    /// Get access to the app state
    pub fn app_state(&self) -> &Arc<AppState> {
        &self.app_state
    }
    
    /// Execute a buy operation when target buys - simplified without tracking
    pub async fn execute_buy(&self, trade_info: &TradeInfoFromToken) -> Result<()> {
        self.logger.log(format!("Executing BUY for token: {}", trade_info.mint).green().to_string());
        
        // Create buy config with amount limiting
        let mut buy_config = (*self.swap_config).clone();
        buy_config.swap_direction = SwapDirection::Buy;
        
        // Define max buy amount to prevent BuyMoreBaseAmountThanPoolReserves errors
        const MAX_BUY_AMOUNT: f64 = 1.0; // 1 SOL max buy amount
        
        // Use configured TOKEN_AMOUNT from .env file and apply safety limit
        let configured_amount = buy_config.amount_in; // This contains TOKEN_AMOUNT from .env
        let limited_amount = configured_amount.min(MAX_BUY_AMOUNT);
        
        if limited_amount != configured_amount {
            self.logger.log(format!("Limited buy amount from {} to {} SOL (max_buy_amount)", 
                configured_amount, limited_amount).yellow().to_string());
        }
        
        self.logger.log(format!("Using buy amount: {} SOL (from TOKEN_AMOUNT config)", limited_amount).green().to_string());
        buy_config.amount_in = limited_amount;

        // Execute buy based on protocol
        let result = match self.get_protocol_from_trade_info(trade_info) {
            SwapProtocol::PumpFun => {
                let pump = Pump::new(
                    self.app_state.rpc_nonblocking_client.clone(),
                    self.app_state.rpc_client.clone(),
                    self.app_state.wallet.clone(),
                );
                
                match pump.build_swap_from_parsed_data(trade_info, buy_config).await {
                    Ok((keypair, instructions, price)) => {
                        self.logger.log(format!("Generated PumpFun buy instruction at price: {}", price));
                        
                        // Get recent blockhash
                        let recent_blockhash = match crate::services::blockhash_processor::BlockhashProcessor::get_latest_blockhash().await {
                            Some(hash) => hash,
                            None => {
                                self.logger.log("Failed to get recent blockhash".red().to_string());
                                return Err(anyhow!("Failed to get recent blockhash"));
                            }
                        };
                        
                        // Execute with transaction landing mode
                        match crate::core::tx::new_signed_and_send_with_landing_mode(
                            self.transaction_landing_mode.clone(),
                            &self.app_state,
                            recent_blockhash,
                            &keypair,
                            instructions,
                            &self.logger,
                        ).await {
                            Ok(signatures) => {
                                if signatures.is_empty() {
                                    return Err(anyhow!("No transaction signature returned"));
                                }
                                
                                let signature = &signatures[0];
                                self.logger.log(format!("Buy transaction sent: {}", signature).green().to_string());
                                
                                Ok(())
                            },
                            Err(e) => {
                                self.logger.log(format!("Buy transaction failed: {}", e).red().to_string());
                                Err(anyhow!("Failed to send buy transaction: {}", e))
                            }
                        }
                    },
                    Err(e) => {
                        self.logger.log(format!("Failed to build PumpFun buy instruction: {}", e).red().to_string());
                        Err(anyhow!("Failed to build buy instruction: {}", e))
                    }
                }
            },
            SwapProtocol::PumpSwap => {
                let pump_swap = PumpSwap::new(
                    self.app_state.wallet.clone(),
                    Some(self.app_state.rpc_client.clone()),
                    Some(self.app_state.rpc_nonblocking_client.clone()),
                );
                
                // Try with original amount first, then retry with reduced amounts if needed
                let mut attempt_amount = buy_config.amount_in;
                let mut last_error: Option<anyhow::Error> = None;
                
                for attempt in 1..=3 {
                    self.logger.log(format!("PumpSwap buy attempt {} with amount: {}", attempt, attempt_amount).blue().to_string());
                    
                    let mut retry_config = buy_config.clone();
                    retry_config.amount_in = attempt_amount;
                    
                    match pump_swap.build_swap_from_parsed_data(trade_info, retry_config).await {
                        Ok((keypair, instructions, price)) => {
                            self.logger.log(format!("Generated PumpSwap buy instruction at price: {}", price));
                            
                            // Get recent blockhash
                            let recent_blockhash = match crate::services::blockhash_processor::BlockhashProcessor::get_latest_blockhash().await {
                                Some(hash) => hash,
                                None => {
                                    self.logger.log("Failed to get recent blockhash".red().to_string());
                                    return Err(anyhow!("Failed to get recent blockhash"));
                                }
                            };
                            
                            // Execute with transaction landing mode
                            match crate::core::tx::new_signed_and_send_with_landing_mode(
                                self.transaction_landing_mode.clone(),
                                &self.app_state,
                                recent_blockhash,
                                &keypair,
                                instructions,
                                &self.logger,
                            ).await {
                                Ok(signatures) => {
                                    if signatures.is_empty() {
                                        return Err(anyhow!("No transaction signature returned"));
                                    }
                                    
                                    let signature = &signatures[0];
                                    self.logger.log(format!("Buy transaction sent: {}", signature).green().to_string());
                                    
                                    return Ok(());
                                },
                                Err(e) => {
                                    let error_str = e.to_string();
                                    if error_str.contains("BuyMoreBaseAmountThanPoolReserves") || error_str.contains("0x1780") {
                                        self.logger.log(format!("BuyMoreBaseAmountThanPoolReserves error on attempt {}, reducing amount", attempt).yellow().to_string());
                                        last_error = Some(anyhow!("BuyMoreBaseAmountThanPoolReserves error: {}", e));
                                        
                                        // Reduce amount by 50% for next attempt
                                        attempt_amount *= 0.5;
                                        
                                        if attempt_amount < 0.001 {
                                            self.logger.log("Amount too small, giving up".red().to_string());
                                            break;
                                        }
                                        
                                        continue;
                                    } else {
                                        self.logger.log(format!("Buy transaction failed: {}", e).red().to_string());
                                        return Err(anyhow!("Failed to send buy transaction: {}", e));
                                    }
                                }
                            }
                        },
                        Err(e) => {
                            self.logger.log(format!("Failed to build PumpSwap buy instruction: {}", e).red().to_string());
                            last_error = Some(anyhow!("Failed to build buy instruction: {}", e));
                            
                            // If it's a pool reserves error, try with reduced amount
                            if e.to_string().contains("Pool has zero reserves") || e.to_string().contains("exceeds pool reserves") {
                                attempt_amount *= 0.5;
                                if attempt_amount < 0.001 {
                                    break;
                                }
                                continue;
                            }
                            
                            return Err(anyhow!("Failed to build buy instruction: {}", e));
                        }
                    }
                }
                
                // If we get here, all attempts failed
                Err(last_error.unwrap_or_else(|| anyhow!("All buy attempts failed")))
            },
            SwapProtocol::RaydiumLaunchpad => {
                Err(anyhow!("RaydiumLaunchpad is not implemented in this build"))
            },
            _ => Err(anyhow!("Unsupported protocol")),
        };
        
        result
    }
    
    /// Execute a sell operation when target sells - returns the tx signature on success
    pub async fn execute_sell(&self, trade_info: &TradeInfoFromToken) -> Result<String> {
        self.logger.log(format!("Executing SELL for token: {}", trade_info.mint).red().to_string());
        
        // Always attempt to sell using Jupiter as primary method since we're not tracking ownership
        self.logger.log("Attempting Jupiter sell for target token...".magenta().to_string());
        
        // Get wallet pubkey
        let wallet_pubkey = self.app_state.wallet.try_pubkey()
            .map_err(|e| anyhow!("Failed to get wallet pubkey: {}", e))?;

        // Get token account address
        let token_pubkey = Pubkey::from_str(&trade_info.mint)
            .map_err(|e| anyhow!("Invalid token mint address: {}", e))?;
        let ata = get_associated_token_address(&wallet_pubkey, &token_pubkey);
        
        // Try to get current token balance
        match self.get_token_balance_direct(&trade_info.mint, &ata).await {
            Ok((token_amount_raw, token_amount, token_decimals)) => {
                if token_amount <= 0.0 {
                    self.logger.log(format!("No balance found for token {}, skipping sell", trade_info.mint).yellow().to_string());
                    return Err(anyhow!("No balance for token"));
                }
                
                self.logger.log(format!("Found balance for {}: {} tokens ({} raw units)", 
                    trade_info.mint, token_amount, token_amount_raw).green().to_string());
                
                // Determine sell amount: match detected buy token amount if available
                // Note: parser sets token_change = token_amount_raw / 1e9 for all protocols
                // so convert back to raw by multiplying by 1e9, independent of token_decimals
                let detected_buy_amount_raw = if trade_info.is_buy && trade_info.token_change > 0.0 {
                    let raw = (trade_info.token_change * 1_000_000_000.0).floor() as u64;
                    raw.min(token_amount_raw)
                } else {
                    token_amount_raw
                };
                let detected_buy_amount_decimal = detected_buy_amount_raw as f64 / 10f64.powi(token_decimals as i32);
                self.logger.log(format!(
                    "Selling amount decided: {} raw units ({} tokens)",
                    detected_buy_amount_raw,
                    detected_buy_amount_decimal
                ).cyan().to_string());

                // Create sell config
                let mut sell_config = (*self.swap_config).clone();
                sell_config.swap_direction = SwapDirection::Sell;
                sell_config.amount_in = detected_buy_amount_decimal;

                match self.execute_sell_with_retries(trade_info, sell_config, (detected_buy_amount_raw, token_decimals)).await {
                    Ok(signature) => {
                        self.logger.log(format!("Sell successful: {}", signature).green().to_string());
                        Ok(signature)
                    },
                    Err(e) => {
                        self.logger.log(format!("Sell failed: {}", e).red().to_string());
                        Err(e)
                    }
                }
            },
            Err(e) => {
                self.logger.log(format!("No token account found for {}: {}", trade_info.mint, e).yellow().to_string());
                Err(anyhow!("No token account found"))
            }
        }
    }

    /// Execute sell with retries using native protocols with cached balance
    async fn execute_sell_with_retries(&self, trade_info: &TradeInfoFromToken, sell_config: SwapConfig, cached_balance: (u64, u8)) -> Result<String> {
        const MAX_RETRIES: u32 = 3;
        let mut last_error: Option<anyhow::Error> = None;

        for attempt in 1..=MAX_RETRIES {
            self.logger.log(format!("Sell attempt {}/{} for token: {}", attempt, MAX_RETRIES, trade_info.mint).cyan().to_string());
            
            let result = match self.get_protocol_from_trade_info(trade_info) {
                SwapProtocol::PumpFun => {
                    self.logger.log(format!("Sell attempt {} using PumpFun protocol", attempt).blue().to_string());
                    
                    let pump = Pump::new(
                        self.app_state.rpc_nonblocking_client.clone(),
                        self.app_state.rpc_client.clone(),
                        self.app_state.wallet.clone(),
                    );
                    
                    self.execute_protocol_sell(&pump, trade_info, sell_config.clone(), cached_balance).await
                },
                SwapProtocol::PumpSwap => {
                    self.logger.log(format!("Sell attempt {} using PumpSwap protocol", attempt).blue().to_string());
                    
                    let pump_swap = PumpSwap::new(
                        self.app_state.wallet.clone(),
                        Some(self.app_state.rpc_client.clone()),
                        Some(self.app_state.rpc_nonblocking_client.clone()),
                    );
                    
                    self.execute_protocol_sell(&pump_swap, trade_info, sell_config.clone(), cached_balance).await
                },
                SwapProtocol::RaydiumLaunchpad => {
                    self.logger.log("RaydiumLaunchpad sell path is not implemented in this build".yellow().to_string());
                    Err(anyhow!("Unsupported protocol for sell: RaydiumLaunchpad"))
                },
                _ => {
                    Err(anyhow!("Unsupported protocol for sell: {:?}", self.get_protocol_from_trade_info(trade_info)))
                }
            };

            match result {
                Ok(signature) => {
                    // Transaction sent successfully
                    self.logger.log(format!("Sell attempt {} sent successfully: {}", attempt, signature).green().to_string());
                    return Ok(signature);
                },
                Err(e) => {
                    self.logger.log(format!("Sell attempt {} failed: {}", attempt, e).red().to_string());
                    last_error = Some(e);
                }
            }

            // Wait before retry (except on last attempt)
            if attempt < MAX_RETRIES {
                self.logger.log(format!("Waiting 2 seconds before retry attempt {}...", attempt + 1).yellow().to_string());
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
            }
        }

        Err(last_error.unwrap_or_else(|| anyhow!("All sell attempts failed")))
    }

    /// Execute protocol-specific sell transaction with cached balance for minimal latency
    async fn execute_protocol_sell<T>(&self, protocol: &T, trade_info: &TradeInfoFromToken, sell_config: SwapConfig, cached_balance: (u64, u8)) -> Result<String>
    where
        T: ProtocolSellWithBalance,
    {
        // Build swap instruction using cached balance method for faster execution
        let (keypair, instructions, price) = protocol.build_swap_from_parsed_data_with_balance(
            trade_info, 
            sell_config, 
            Some(cached_balance)
        ).await?;
        
        // Get recent blockhash
        let recent_blockhash = match crate::services::blockhash_processor::BlockhashProcessor::get_latest_blockhash().await {
            Some(hash) => hash,
            None => {
                return Err(anyhow!("Failed to get recent blockhash"));
            }
        };
        
        self.logger.log(format!("Generated sell instruction at price: {} using cached balance", price));
        
        // Use zeroslot directly for minimal latency selling
        match crate::core::tx::new_signed_and_send_zeroslot(
            self.app_state.zeroslot_rpc_client.clone(),
            recent_blockhash,
            &keypair,
            instructions,
            &self.logger,
        ).await {
            Ok(signatures) => {
                if signatures.is_empty() {
                    return Err(anyhow!("No transaction signature returned"));
                }
                
                Ok(signatures[0].clone())
            },
            Err(e) => {
                Err(anyhow!("Failed to send sell transaction: {}", e))
            }
        }
    }


    /// Public method to sell all tokens in wallet using Jupiter API
    /// This mimics the functionality of "cargo r -- --sell" command
    pub async fn sell_all_tokens(&self) -> Result<()> {
        self.logger.log("🚀 Starting bulk sell operation using Jupiter API".cyan().bold().to_string());
        
        // Discover all token accounts
        let token_accounts = self.discover_wallet_tokens().await?;
        
        if token_accounts.is_empty() {
            self.logger.log("ℹ️  No tokens found to sell".yellow().to_string());
            return Ok(());
        }
        
        self.logger.log(format!("📊 Found {} tokens to potentially sell", token_accounts.len()).blue().to_string());
        
        let mut successful_sales = 0;
        let mut failed_sales = 0;
        let mut total_sol_received = 0.0;
        let mut skipped_tokens = 0;
        
        // Sell each token using Jupiter
        for (index, token) in token_accounts.iter().enumerate() {
            self.logger.log(format!("🔄 Processing token {}/{}: {}", 
                index + 1, token_accounts.len(), token.mint).cyan().to_string());
            
            // Skip SOL and WSOL
            if token.mint == SOL_MINT || token.mint == WSOL_MINT {
                self.logger.log(format!("⏭️  Skipping SOL/WSOL token: {}", token.mint).yellow().to_string());
                skipped_tokens += 1;
                continue;
            }
            
            // Check if token has meaningful value (skip dust)
            if token.amount <= 0.000001 {
                self.logger.log(format!("⏭️  Skipping dust token {}: {} amount", token.mint, token.amount).yellow().to_string());
                skipped_tokens += 1;
                continue;
            }
            
            self.logger.log(format!("💰 Attempting to sell token: {} (amount: {}, raw: {})", 
                token.mint, token.amount, token.amount_raw).green().to_string());
            
            match self.sell_single_token_jupiter(token).await {
                Ok(signature) => {
                    self.logger.log(format!("✅ Successfully sold token {}: {}", token.mint, signature).green().bold().to_string());
                    successful_sales += 1;
                    
                    // Try to estimate SOL received (this is approximate)
                    if let Ok(sol_estimate) = self.estimate_sol_output(&token.mint, token.amount_raw).await {
                        total_sol_received += sol_estimate;
                        self.logger.log(format!("💎 Estimated SOL received: {:.6}", sol_estimate).cyan().to_string());
                    }
                },
                Err(e) => {
                    self.logger.log(format!("❌ Failed to sell token {}: {}", token.mint, e).red().to_string());
                    failed_sales += 1;
                }
            }
            
            // Add delay between swaps to avoid rate limiting
            if index < token_accounts.len() - 1 {
                self.logger.log("⏰ Waiting 1.5s to avoid rate limiting...".blue().to_string());
                tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;
            }
        }
        
        // Final summary
        self.logger.log("=".repeat(60).cyan().to_string());
        self.logger.log(format!(
            "🎯 Bulk selling completed!\n   ✅ {} successful\n   ❌ {} failed\n   ⏭️  {} skipped\n   💰 ~{:.6} SOL received",
            successful_sales, failed_sales, skipped_tokens, total_sol_received
        ).cyan().bold().to_string());
        self.logger.log("=".repeat(60).cyan().to_string());
        
        // Trigger SOL/WSOL balance management after successful sales
        if successful_sales > 0 {
            self.logger.log("🔄 Triggering SOL/WSOL balance management after bulk selling...".cyan().to_string());
            let balance_manager = BalanceManager::new(self.app_state.clone());
            if let Err(e) = balance_manager.manage_balances_after_selling().await {
                self.logger.log(format!("⚠️ Balance management failed: {}", e).red().to_string());
            } else {
                self.logger.log("✅ Balance management completed successfully".green().to_string());
            }
        }
        
        if failed_sales > 0 {
            Err(anyhow!("Some token sales failed: {} out of {}", failed_sales, successful_sales + failed_sales))
        } else {
            Ok(())
        }
    }
    
    /// Discover all token accounts in the wallet
    async fn discover_wallet_tokens(&self) -> Result<Vec<WalletTokenInfo>> {
        self.logger.log("Discovering wallet token accounts...".blue().to_string());
        
        let wallet_pubkey = self.app_state.wallet.try_pubkey()
            .map_err(|e| anyhow!("Failed to get wallet pubkey: {}", e))?;
        
        // Get the token program pubkey
        let token_program = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")?;
        
        // Query all token accounts owned by the wallet
        let accounts = self.app_state.rpc_client.get_token_accounts_by_owner(
            &wallet_pubkey,
            anchor_client::solana_client::rpc_request::TokenAccountsFilter::ProgramId(token_program)
        ).map_err(|e| anyhow!("Failed to get token accounts: {}", e))?;
        
        let mut token_accounts = Vec::new();
        
        for account_info in accounts {
            let token_account_pubkey = Pubkey::from_str(&account_info.pubkey)
                .map_err(|_| anyhow!("Invalid token account pubkey: {}", account_info.pubkey))?;
            
            // Get account data
            let account_data = match self.app_state.rpc_client.get_account(&token_account_pubkey) {
                Ok(data) => data,
                Err(e) => {
                    self.logger.log(format!("Failed to get account data for {}: {}", token_account_pubkey, e).yellow().to_string());
                    continue;
                }
            };
            
            // Parse token account data
            if let Ok(token_data) = spl_token::state::Account::unpack(&account_data.data) {
                if token_data.amount > 0 {
                    // Get proper decimals from mint account
                    let decimals = match self.app_state.rpc_client.get_account(&token_data.mint) {
                        Ok(mint_account) => {
                            if let Ok(mint_data) = spl_token::state::Mint::unpack(&mint_account.data) {
                                mint_data.decimals
                            } else {
                                9 // Default decimals
                            }
                        },
                        Err(_) => 9 // Default decimals
                    };
                    
                    // Convert amount to UI amount using proper decimals
                    let ui_amount = token_data.amount as f64 / 10f64.powi(decimals as i32);
                    
                    if ui_amount > 0.0 {
                        token_accounts.push(WalletTokenInfo {
                            mint: token_data.mint.to_string(),
                            account_pubkey: token_account_pubkey,
                            amount: ui_amount,
                            amount_raw: token_data.amount,
                            decimals,
                        });
                        
                        self.logger.log(format!("Found token: {} (amount: {}, raw: {})", 
                            token_data.mint, ui_amount, token_data.amount).green().to_string());
                    }
                }
            }
        }
        
        self.logger.log(format!("Discovered {} token accounts with balances", token_accounts.len()).blue().to_string());
        Ok(token_accounts)
    }
    
    /// Sell a single token using Jupiter API (using the same working approach as main.rs --sell)
    async fn sell_single_token_jupiter(&self, token: &WalletTokenInfo) -> Result<String> {
        self.logger.log(format!("Selling token {} using Jupiter API (amount: {})", token.mint, token.amount_raw).magenta().to_string());
        
        // Skip SOL and WSOL
        if token.mint == SOL_MINT || token.mint == WSOL_MINT {
            self.logger.log("Skipping SOL/WSOL token".to_string());
            return Ok("Skipped SOL/WSOL".to_string());
        }
        
        self.logger.log(format!("Selling {} {} (decimals: {})", token.amount, token.mint, token.decimals));
        self.logger.log(format!("Amount in smallest unit: {}", token.amount_raw));
        
        // Get quote from Jupiter using the working main.rs functions
        let quote = self.get_jupiter_quote(
            &token.mint,
            SOL_MINT,
            token.amount_raw,
            100, // 1% slippage
        ).await.map_err(|e| anyhow!("Jupiter quote failed: {}", e))?;
        
        // Calculate expected SOL output
        let expected_sol = quote.out_amount.parse::<u64>()
            .map_err(|e| anyhow!("Failed to parse output amount: {}", e))? as f64 / 1e9;
        
        // Check if expected output is worthwhile (more than 0.0001 SOL)
        if expected_sol < 0.0001 {
            return Err(anyhow!("Expected SOL output too small: {} SOL", expected_sol));
        }
        
        self.logger.log(format!("Expected SOL output: {}", expected_sol));
        
        // Get wallet pubkey
        let wallet_pubkey = self.app_state.wallet.try_pubkey()
            .map_err(|e| anyhow!("Failed to get wallet pubkey: {}", e))?;
        
        // Get swap transaction using the working main.rs functions
        let swap_transaction = self.get_jupiter_swap_transaction(quote, &wallet_pubkey.to_string()).await
            .map_err(|e| anyhow!("Get swap transaction failed: {}", e))?;
        
        // Execute the swap using the working main.rs functions
        let signature = self.execute_swap_transaction(&swap_transaction).await
            .map_err(|e| anyhow!("Execute swap transaction failed: {}", e))?;
        
        self.logger.log(format!("Token sold successfully! Signature: {}", signature));
        Ok(signature)
    }
    
    /// Estimate SOL output for a token sale (for reporting purposes)
    async fn estimate_sol_output(&self, token_mint: &str, amount_raw: u64) -> Result<f64> {
        match self.get_jupiter_quote(token_mint, SOL_MINT, amount_raw, 100).await {
            Ok(quote) => {
                let sol_amount_raw = quote.out_amount.parse::<u64>()
                    .map_err(|e| anyhow!("Failed to parse output amount: {}", e))?;
                Ok(sol_amount_raw as f64 / 1e9)
            },
            Err(_) => Ok(0.0) // Return 0 if we can't get a quote
        }
    }

    /// Get Jupiter quote for token swap (copied from main.rs)
    async fn get_jupiter_quote(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
        slippage_bps: u16,
    ) -> Result<JupiterQuoteResponse, String> {
        self.logger.log(format!("Getting quote: {} -> {} (amount: {})", input_mint, output_mint, amount));
        
        let client = reqwest::Client::new();
        let url = format!(
            "{}/v6/quote?inputMint={}&outputMint={}&amount={}&slippageBps={}",
            JUPITER_API_URL, input_mint, output_mint, amount, slippage_bps
        );
        
        let response = client.get(&url)
            .send()
            .await
            .map_err(|e| format!("Failed to get quote: {}", e))?;
        
        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("Quote API returned status: {} - {}", status, error_text));
        }
        
        // Log the raw response for debugging
        let response_text = response.text().await
            .map_err(|e| format!("Failed to read response text: {}", e))?;
        self.logger.log(format!("Raw quote response (first 500 chars): {}", 
            &response_text[..std::cmp::min(500, response_text.len())]));
        
        let quote: JupiterQuoteResponse = serde_json::from_str(&response_text)
            .map_err(|e| format!("Failed to parse quote response: {}. Response: {}", e, 
                &response_text[..std::cmp::min(200, response_text.len())]))?;
        
        self.logger.log(format!("Quote received: {} {} -> {} {}", 
                         quote.in_amount, input_mint, quote.out_amount, output_mint));
        
        Ok(quote)
    }

    /// Get Jupiter swap transaction (copied from main.rs)
    async fn get_jupiter_swap_transaction(
        &self,
        quote: JupiterQuoteResponse,
        user_public_key: &str,
    ) -> Result<String, String> {
        self.logger.log("Getting swap transaction from Jupiter".to_string());
        
        let client = reqwest::Client::new();
        let url = "https://lite-api.jup.ag/swap/v1/swap";
        
        let swap_request = JupiterSwapRequest {
            quote_response: quote,
            user_public_key: user_public_key.to_string(),
            wrap_and_unwrap_sol: true,
            dynamic_compute_unit_limit: false, 
            prioritization_fee_lamports: PrioritizationFeeLamports {
                priority_level_with_max_lamports: PriorityLevelWithMaxLamports {
                    max_lamports: 1000000,
                    priority_level: "high".to_string(),
                },
            },
        };
        
        // Log the request for debugging
        self.logger.log(format!("Sending swap request to: {}", url));
        self.logger.log(format!("Request payload (first 300 chars): {}", 
            serde_json::to_string(&swap_request)
                .unwrap_or_else(|_| "Failed to serialize".to_string())
                .chars().take(300).collect::<String>()));
        
        let response = client.post(url)
            .json(&swap_request)
            .send()
            .await
            .map_err(|e| format!("Failed to get swap transaction: {}", e))?;
        
        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            self.logger.log(format!("Jupiter swap API error: Status {}, Response: {}", status, error_text));
            return Err(format!("Swap API returned status: {} - {}", status, error_text));
        }
        
        let swap_response: JupiterSwapResponse = response.json()
            .await
            .map_err(|e| format!("Failed to parse swap response: {}", e))?;
        
        self.logger.log("Swap transaction received from Jupiter".to_string());
        Ok(swap_response.swap_transaction)
    }

    /// Execute Jupiter swap transaction (copied from main.rs)
    async fn execute_swap_transaction(
        &self,
        swap_transaction_base64: &str,
    ) -> Result<String, String> {
        self.logger.log("Executing swap transaction".to_string());
        
        // Decode the base64 transaction
        let transaction_bytes = base64::decode(swap_transaction_base64)
            .map_err(|e| format!("Failed to decode transaction: {}", e))?;
        
        // Try to deserialize as versioned transaction first (Jupiter v6 primarily uses versioned transactions)
        if let Ok(mut transaction) = bincode::deserialize::<VersionedTransaction>(&transaction_bytes) {
            self.logger.log("Processing as versioned transaction".to_string());
            
            // Get recent blockhash
            let recent_blockhash = self.app_state.rpc_client.get_latest_blockhash()
                .map_err(|e| format!("Failed to get recent blockhash: {}", e))?;
            
            // Update the transaction's blockhash
            transaction.message.set_recent_blockhash(recent_blockhash);
            
            // Sign the versioned transaction
            let message_data = transaction.message.serialize();
            let signature = self.app_state.wallet.sign_message(&message_data);
            
            // Find the position of the keypair in the account keys to place the signature
            let account_keys = transaction.message.static_account_keys();
            if let Some(signer_index) = account_keys.iter().position(|key| *key == self.app_state.wallet.pubkey()) {
                // Ensure we have enough signatures
                if transaction.signatures.len() <= signer_index {
                    transaction.signatures.resize(signer_index + 1, anchor_client::solana_sdk::signature::Signature::default());
                }
                transaction.signatures[signer_index] = signature;
            } else {
                return Err("Wallet not found in transaction account keys".to_string());
            }
            
            // Send the transaction with retry logic
            let mut attempts = 0;
            let max_attempts = 3;
            
            while attempts < max_attempts {
                attempts += 1;
                
                // Try to convert versioned transaction to legacy transaction for zeroslot compatibility
                if let Some(legacy_tx) = transaction.clone().into_legacy_transaction() {
                    // Send the legacy transaction using zeroslot for minimal latency
                    match self.app_state.zeroslot_rpc_client.send_transaction(&legacy_tx).await {
                        Ok(signature) => {
                            self.logger.log(format!("Versioned swap transaction sent via zeroslot: {}", signature));
                            
                            // Wait for confirmation
                            for _ in 0..30 { // Wait up to 30 seconds for confirmation
                                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                                
                                if let Ok(status) = self.app_state.rpc_client.get_signature_status(&signature) {
                                    if let Some(result) = status {
                                        if result.is_ok() {
                                            self.logger.log(format!("Versioned swap transaction confirmed: {}", signature));
                                            return Ok(signature.to_string());
                                        } else {
                                            return Err(format!("Transaction failed: {:?}", result));
                                        }
                                    }
                                }
                            }
                            
                            return Err("Transaction confirmation timeout".to_string());
                        },
                        Err(e) => {
                            let error_msg = format!("{}", e);
                            self.logger.log(format!("Versioned swap attempt {}/{} failed: {}", attempts, max_attempts, error_msg).red().to_string());
                            
                            if attempts >= max_attempts {
                                return Err(format!("All versioned swap attempts failed. Last error: {}", error_msg));
                            }
                            
                            // Wait before retry
                            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                        }
                    }
                } else {
                    // If conversion to legacy transaction fails, use normal RPC client as fallback
                    self.logger.log("Cannot convert versioned transaction to legacy, using normal RPC".yellow().to_string());
                    match self.app_state.rpc_client.send_transaction(&transaction) {
                        Ok(signature) => {
                            self.logger.log(format!("Versioned swap transaction sent via normal RPC: {}", signature));
                            
                            // Wait for confirmation
                            for _ in 0..30 { // Wait up to 30 seconds for confirmation
                                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                                
                                if let Ok(status) = self.app_state.rpc_client.get_signature_status(&signature) {
                                    if let Some(result) = status {
                                        if result.is_ok() {
                                            self.logger.log(format!("Versioned swap transaction confirmed: {}", signature));
                                            return Ok(signature.to_string());
                                        } else {
                                            return Err(format!("Transaction failed: {:?}", result));
                                        }
                                    }
                                }
                            }
                            
                            return Err("Transaction confirmation timeout".to_string());
                        },
                        Err(e) => {
                            let error_msg = format!("{}", e);
                            self.logger.log(format!("Versioned swap attempt {}/{} failed: {}", attempts, max_attempts, error_msg).red().to_string());
                            
                            if attempts >= max_attempts {
                                return Err(format!("All versioned swap attempts failed. Last error: {}", error_msg));
                            }
                            
                            // Wait before retry
                            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                        }
                    }
                }
            }
        } else if let Ok(mut transaction) = bincode::deserialize::<Transaction>(&transaction_bytes) {
            self.logger.log("Processing as legacy transaction".to_string());
            
            // Get recent blockhash
            let recent_blockhash = self.app_state.rpc_client.get_latest_blockhash()
                .map_err(|e| format!("Failed to get recent blockhash: {}", e))?;
            
            // Update the transaction's blockhash
            transaction.message.recent_blockhash = recent_blockhash;
            
            // Sign the transaction
            transaction.sign(&[&self.app_state.wallet], recent_blockhash);
            
            // Send the transaction with retry logic
            let mut attempts = 0;
            let max_attempts = 3;
            
            while attempts < max_attempts {
                attempts += 1;
                
                // Send the transaction using zeroslot for minimal latency
                match self.app_state.zeroslot_rpc_client.send_transaction(&transaction).await {
                    Ok(signature) => {
                        self.logger.log(format!("Swap transaction sent via zeroslot: {}", signature));
                        
                        // Wait for confirmation
                        for _ in 0..30 { // Wait up to 30 seconds for confirmation
                            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                            
                            if let Ok(status) = self.app_state.rpc_client.get_signature_status(&signature) {
                                if let Some(result) = status {
                                    if result.is_ok() {
                                        self.logger.log(format!("Swap transaction confirmed: {}", signature));
                                        return Ok(signature.to_string());
                                    } else {
                                        return Err(format!("Transaction failed: {:?}", result));
                                    }
                                }
                            }
                        }
                        
                        return Err("Transaction confirmation timeout".to_string());
                    },
                    Err(e) => {
                        let error_msg = format!("{}", e);
                        self.logger.log(format!("Swap attempt {}/{} failed: {}", attempts, max_attempts, error_msg).red().to_string());
                        
                        if attempts >= max_attempts {
                            return Err(format!("All swap attempts failed. Last error: {}", error_msg));
                        }
                        
                        // Wait before retry
                        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                    }
                }
            }
        } else {
            // If Jupiter returns neither transaction format, return an error
            self.logger.log("Transaction format not supported - unable to deserialize as legacy or versioned transaction".yellow().to_string());
            return Err("Unsupported transaction format - unable to deserialize as legacy or versioned transaction".to_string());
        }
        
        Err("Maximum retry attempts exceeded".to_string())
    }

    /// Get token balance directly from RPC without caching
    async fn get_token_balance_direct(&self, mint: &str, ata: &Pubkey) -> Result<(u64, f64, u8)> {
        self.logger.log(format!("Fetching fresh balance for {} (account: {}) directly from RPC", mint, ata).yellow().to_string());
        match self.app_state.rpc_nonblocking_client.get_token_account(ata).await {
            Ok(Some(account)) => {
                let amount_raw = account.token_amount.amount.parse::<u64>()
                    .map_err(|e| anyhow!("Failed to parse token amount: {}", e))?;
                let decimal_amount = account.token_amount.amount.parse::<f64>()
                    .map_err(|e| anyhow!("Failed to parse token amount: {}", e))?
                    / 10f64.powi(account.token_amount.decimals as i32);
                let decimals = account.token_amount.decimals;
                
                self.logger.log(format!("Fetched fresh balance for {}: {} tokens ({} raw units)", 
                    mint, decimal_amount, amount_raw).green().to_string());
                
                Ok((amount_raw, decimal_amount, decimals))
            },
            Ok(None) => {
                self.logger.log(format!("No token account found for mint: {}", mint).yellow().to_string());
                Err(anyhow!("Token account not found"))
            },
            Err(e) => {
                Err(anyhow!("Failed to get token account: {}", e))
            }
        }
    }
    
    /// Determine protocol from trade info
    fn get_protocol_from_trade_info(&self, trade_info: &TradeInfoFromToken) -> SwapProtocol {
        match trade_info.dex_type {
            DexType::PumpSwap => SwapProtocol::PumpSwap,
            DexType::PumpFun => SwapProtocol::PumpFun,
            DexType::RaydiumLaunchpad => SwapProtocol::RaydiumLaunchpad,
            _ => self.app_state.protocol_preference.clone(),
        }
    }
}

/// Trait for protocol-specific sell operations with cached balance for minimal latency
trait ProtocolSellWithBalance {
    fn build_swap_from_parsed_data_with_balance(&self, trade_info: &TradeInfoFromToken, swap_config: SwapConfig, cached_balance: Option<(u64, u8)>) -> impl std::future::Future<Output = Result<(Arc<Keypair>, Vec<Instruction>, f64)>> + Send;
}

impl ProtocolSellWithBalance for Pump {
    async fn build_swap_from_parsed_data_with_balance(&self, trade_info: &TradeInfoFromToken, swap_config: SwapConfig, cached_balance: Option<(u64, u8)>) -> Result<(Arc<Keypair>, Vec<Instruction>, f64)> {
        self.build_swap_from_parsed_data_with_balance(trade_info, swap_config, cached_balance).await
    }
}

impl ProtocolSellWithBalance for PumpSwap {
    async fn build_swap_from_parsed_data_with_balance(&self, trade_info: &TradeInfoFromToken, swap_config: SwapConfig, cached_balance: Option<(u64, u8)>) -> Result<(Arc<Keypair>, Vec<Instruction>, f64)> {
        self.build_swap_from_parsed_data_with_balance(trade_info, swap_config, cached_balance).await
    }
}

/// Convenience function to create a SimpleSellingEngine and sell all tokens
/// This can be used by external modules like main.rs for risk management
pub async fn sell_all_wallet_tokens_with_jupiter(
    app_state: Arc<AppState>,
    swap_config: Arc<SwapConfig>,
    transaction_landing_mode: crate::common::config::TransactionLandingMode,
) -> Result<()> {
    let selling_engine = SimpleSellingEngine::new(
        app_state,
        swap_config,
        transaction_landing_mode,
    );
    
    selling_engine.sell_all_tokens().await
}

/// Alternative convenience function that uses default settings
pub async fn emergency_sell_all_tokens(app_state: Arc<AppState>) -> Result<()> {
    let swap_config = Arc::new(SwapConfig {
        swap_direction: SwapDirection::Sell,
        in_type: SwapInType::Qty,
        amount_in: 0.1, // Not used for selling
        slippage: 100, // 1% slippage
    });
    
    let transaction_landing_mode = crate::common::config::TransactionLandingMode::Zeroslot;
    
    sell_all_wallet_tokens_with_jupiter(app_state, swap_config, transaction_landing_mode).await
} 
