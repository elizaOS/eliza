use std::sync::Arc;
use std::time::Duration;
use anyhow::Result;
use colored::Colorize;
use tokio::time::{interval, Instant};
use anchor_client::solana_sdk::signature::Signer;
use solana_program_pack::Pack;

use crate::common::{config::AppState, logger::Logger};
use crate::engine::selling_strategy::emergency_sell_all_tokens;
use crate::services::balance_manager::BalanceManager;

/// Balance monitoring service that checks token balances every 2 minutes
/// and triggers automatic selling to prevent token accumulation
pub struct BalanceMonitorService {
    app_state: Arc<AppState>,
    balance_manager: BalanceManager,
    logger: Logger,
    monitoring_interval: Duration,
    is_running: Arc<tokio::sync::RwLock<bool>>,
}

impl BalanceMonitorService {
    /// Create a new balance monitoring service
    pub fn new(app_state: Arc<AppState>) -> Self {
        let balance_manager = BalanceManager::new(app_state.clone());
        
        // Get monitoring interval from environment or use default (2 minutes)
        let interval_seconds = std::env::var("BALANCE_MONITOR_INTERVAL_SECONDS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(120); // Default: 2 minutes
        
        Self {
            app_state,
            balance_manager,
            logger: Logger::new("[BALANCE-MONITOR] => ".cyan().bold().to_string()),
            monitoring_interval: Duration::from_secs(interval_seconds),
            is_running: Arc::new(tokio::sync::RwLock::new(false)),
        }
    }
    
    /// Start the balance monitoring service
    pub async fn start_monitoring(&self) -> Result<()> {
        // Check if already running
        {
            let mut running = self.is_running.write().await;
            if *running {
                return Ok(());
            }
            *running = true;
        }
        
        self.logger.log(format!("🚀 Starting balance monitoring service (interval: {:?})", self.monitoring_interval).green().bold().to_string());
        
        let mut interval_timer = interval(self.monitoring_interval);
        let app_state = self.app_state.clone();
        let balance_manager = self.balance_manager.clone();
        let logger = self.logger.clone();
        let is_running = self.is_running.clone();
        
        tokio::spawn(async move {
            loop {
                // Check if service should continue running
                {
                    let running = is_running.read().await;
                    if !*running {
                        logger.log("⏹️ Balance monitoring service stopped".yellow().to_string());
                        break;
                    }
                }
                
                interval_timer.tick().await;
                
                let check_start = Instant::now();
                logger.log("🔍 Starting periodic balance check and token selling...".cyan().to_string());
                
                // Perform balance check and token selling
                match Self::perform_balance_check_and_sell(&app_state, &balance_manager, &logger).await {
                    Ok(_) => {
                        logger.log(format!("✅ Balance check completed successfully in {:?}", check_start.elapsed()).green().to_string());
                    },
                    Err(e) => {
                        logger.log(format!("❌ Balance check failed: {} (took {:?})", e, check_start.elapsed()).red().to_string());
                    }
                }
            }
        });
        
        Ok(())
    }
    
    /// Stop the balance monitoring service
    pub async fn stop_monitoring(&self) {
        let mut running = self.is_running.write().await;
        *running = false;
        self.logger.log("🛑 Balance monitoring service stop requested".yellow().to_string());
    }
    
    /// Check if the service is currently running
    pub async fn is_running(&self) -> bool {
        *self.is_running.read().await
    }
    
    /// Perform balance check and sell all tokens (mimics "cargo r -- --sell")
    async fn perform_balance_check_and_sell(
        app_state: &Arc<AppState>,
        balance_manager: &BalanceManager,
        logger: &Logger,
    ) -> Result<()> {
        logger.log("📊 Checking wallet token balances...".blue().to_string());
        
        // Check if we have any tokens to sell
        let has_tokens = Self::check_for_sellable_tokens(app_state, logger).await?;
        
        if !has_tokens {
            logger.log("ℹ️ No sellable tokens found, skipping sell operation".green().to_string());
            
            // Still check SOL/WSOL balance and rebalance if needed
            Self::check_and_rebalance_sol_wsol(balance_manager, logger).await?;
            return Ok(());
        }
        
        logger.log("💰 Sellable tokens found, executing emergency sell all...".yellow().to_string());
        
        // Sell all tokens using the emergency sell function (same as "cargo r -- --sell")
        match emergency_sell_all_tokens(app_state.clone()).await {
            Ok(_) => {
                logger.log("✅ Emergency sell all completed successfully".green().bold().to_string());
                
                // Wait a bit for transactions to settle
                tokio::time::sleep(Duration::from_secs(3)).await;
                
                // Trigger SOL/WSOL balance management
                Self::check_and_rebalance_sol_wsol(balance_manager, logger).await?;
                
                // Trigger SOL wrapping if needed
                Self::wrap_sol_for_next_trades(app_state, logger).await?;
                
                Ok(())
            },
            Err(e) => {
                logger.log(format!("❌ Emergency sell all failed: {}", e).red().to_string());
                Err(anyhow::anyhow!("Emergency sell failed: {}", e))
            }
        }
    }
    
    /// Check if we have any sellable tokens in the wallet
    async fn check_for_sellable_tokens(app_state: &Arc<AppState>, logger: &Logger) -> Result<bool> {
        use std::str::FromStr;
        use anchor_client::solana_sdk::pubkey::Pubkey;
        
        let wallet_pubkey = app_state.wallet.pubkey();
        
        // Get the token program pubkey
        let token_program = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")?;
        
        // Query all token accounts owned by the wallet
        let accounts = app_state.rpc_client.get_token_accounts_by_owner(
            &wallet_pubkey,
            anchor_client::solana_client::rpc_request::TokenAccountsFilter::ProgramId(token_program)
        ).map_err(|e| anyhow::anyhow!("Failed to get token accounts: {}", e))?;
        
        let mut sellable_tokens = 0;
        let mut total_tokens = 0;
        
        const SOL_MINT: &str = "So11111111111111111111111111111111111111112";
        const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
        
        for account_info in accounts {
            total_tokens += 1;
            
            let token_account_pubkey = Pubkey::from_str(&account_info.pubkey)
                .map_err(|_| anyhow::anyhow!("Invalid token account pubkey: {}", account_info.pubkey))?;
            
            // Get account data
            let account_data = match app_state.rpc_client.get_account(&token_account_pubkey) {
                Ok(data) => data,
                Err(_) => continue, // Skip if we can't get account data
            };
            
            // Parse token account data
            if let Ok(token_data) = spl_token::state::Account::unpack(&account_data.data) {
                if token_data.amount > 0 {
                    let mint_str = token_data.mint.to_string();
                    
                    // Skip SOL and WSOL
                    if mint_str == SOL_MINT || mint_str == WSOL_MINT {
                        continue;
                    }
                    
                    // Get decimals and calculate UI amount
                    let decimals = match app_state.rpc_client.get_account(&token_data.mint) {
                        Ok(mint_account) => {
                            if let Ok(mint_data) = spl_token::state::Mint::unpack(&mint_account.data) {
                                mint_data.decimals
                            } else {
                                9 // Default decimals
                            }
                        },
                        Err(_) => 9 // Default decimals
                    };
                    
                    let ui_amount = token_data.amount as f64 / 10f64.powi(decimals as i32);
                    
                    // Consider tokens with meaningful amounts as sellable
                    if ui_amount > 0.000001 {
                        sellable_tokens += 1;
                        logger.log(format!("🔍 Found sellable token: {} (amount: {})", mint_str, ui_amount).blue().to_string());
                    }
                }
            }
        }
        
        logger.log(format!("📊 Token scan complete: {} sellable tokens out of {} total token accounts", sellable_tokens, total_tokens).cyan().to_string());
        
        Ok(sellable_tokens > 0)
    }
    
    /// Check and rebalance SOL/WSOL if needed
    async fn check_and_rebalance_sol_wsol(balance_manager: &BalanceManager, logger: &Logger) -> Result<()> {
        logger.log("⚖️ Checking SOL/WSOL balance...".blue().to_string());
        
        match balance_manager.get_current_balances().await {
            Ok(balance_info) => {
                logger.log(format!("💰 Current balances - SOL: {:.6}, WSOL: {:.6}, Total: {:.6}", 
                    balance_info.sol_balance, balance_info.wsol_balance, balance_info.total_balance).cyan().to_string());
                
                if balance_manager.needs_rebalancing(&balance_info) {
                    logger.log("⚖️ Rebalancing needed, performing automatic rebalancing...".yellow().to_string());
                    match balance_manager.rebalance().await {
                        Ok(_) => {
                            logger.log("✅ SOL/WSOL rebalancing completed successfully".green().to_string());
                        },
                        Err(e) => {
                            logger.log(format!("❌ SOL/WSOL rebalancing failed: {}", e).red().to_string());
                            return Err(anyhow::anyhow!("Rebalancing failed: {}", e));
                        }
                    }
                } else {
                    logger.log("✅ SOL/WSOL balances are well balanced".green().to_string());
                }
                
                Ok(())
            },
            Err(e) => {
                logger.log(format!("❌ Failed to check SOL/WSOL balances: {}", e).red().to_string());
                Err(anyhow::anyhow!("Balance check failed: {}", e))
            }
        }
    }
    
    /// Wrap SOL for next trades (mimics "cargo r -- --wrap")
    async fn wrap_sol_for_next_trades(app_state: &Arc<AppState>, logger: &Logger) -> Result<()> {
        logger.log("🔄 Checking if SOL wrapping is needed for next trades...".blue().to_string());
        
        // Get wrap amount from environment variable
        let wrap_amount = std::env::var("WRAP_AMOUNT")
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.1); // Default: 0.1 SOL
        
        // Check if auto-wrapping is enabled
        let auto_wrap_enabled = std::env::var("AUTO_WRAP_ENABLED")
            .ok()
            .and_then(|v| v.parse::<bool>().ok())
            .unwrap_or(true); // Default: enabled
        
        if !auto_wrap_enabled {
            logger.log("ℹ️ Auto-wrapping is disabled via AUTO_WRAP_ENABLED=false".yellow().to_string());
            return Ok(());
        }
        
        // Get current SOL balance to check if we have enough to wrap
        let wallet_pubkey = app_state.wallet.pubkey();
        
        let sol_balance_lamports = app_state.rpc_client.get_balance(&wallet_pubkey)
            .map_err(|e| anyhow::anyhow!("Failed to get SOL balance: {}", e))?;
        let sol_balance = sol_balance_lamports as f64 / 1_000_000_000.0;
        
        // Only wrap if we have enough SOL (keep some buffer for transaction fees)
        let required_balance = wrap_amount + 0.01; // Add 0.01 SOL buffer for fees
        
        if sol_balance < required_balance {
            logger.log(format!("⚠️ Insufficient SOL balance for wrapping: {:.6} < {:.6} (including fee buffer)", sol_balance, required_balance).yellow().to_string());
            return Ok(());
        }
        
        logger.log(format!("🔄 Wrapping {:.6} SOL to WSOL for next trades...", wrap_amount).cyan().to_string());
        
        // Call the wrap_sol function from main.rs (we'll need to extract this to a module)
        match Self::wrap_sol_internal(app_state, wrap_amount, logger).await {
            Ok(_) => {
                logger.log(format!("✅ Successfully wrapped {:.6} SOL to WSOL", wrap_amount).green().to_string());
                Ok(())
            },
            Err(e) => {
                logger.log(format!("❌ Failed to wrap SOL: {}", e).red().to_string());
                // Don't fail the entire balance check if wrapping fails
                Ok(())
            }
        }
    }
    
    /// Internal SOL wrapping function (extracted from main.rs logic)
    async fn wrap_sol_internal(app_state: &Arc<AppState>, amount: f64, logger: &Logger) -> Result<()> {
        use std::str::FromStr;
        use anchor_client::solana_sdk::pubkey::Pubkey;
        use spl_token::ui_amount_to_amount;
        use spl_associated_token_account::get_associated_token_address;
        use anchor_client::solana_sdk::system_instruction;
        use spl_token::instruction::sync_native;
        
        let wallet_pubkey = app_state.wallet.pubkey();
        
        // Get WSOL mint and ATA
        let wsol_mint = Pubkey::from_str("So11111111111111111111111111111111111111112")?;
        let wsol_ata = get_associated_token_address(&wallet_pubkey, &wsol_mint);
        
        logger.log(format!("WSOL account address: {}", wsol_ata));
        
        // Convert UI amount to lamports (1 SOL = 10^9 lamports)
        let lamports = ui_amount_to_amount(amount, 9);
        logger.log(format!("Wrapping {} SOL ({} lamports)", amount, lamports));
        
        let mut instructions = Vec::new();
        
        // Create WSOL account if it doesn't exist
        instructions.push(spl_associated_token_account::instruction::create_associated_token_account_idempotent(
            &wallet_pubkey,
            &wallet_pubkey,
            &wsol_mint,
            &spl_token::id(),
        ));
        
        // Transfer SOL to the WSOL account
        instructions.push(system_instruction::transfer(
            &wallet_pubkey,
            &wsol_ata,
            lamports,
        ));
        
        // Sync native instruction to update the token balance
        instructions.push(sync_native(&spl_token::id(), &wsol_ata)
            .map_err(|e| anyhow::anyhow!("Failed to create sync native instruction: {}", e))?);
        
        // Send transaction using zeroslot for minimal latency
        let recent_blockhash = app_state.rpc_client.get_latest_blockhash()
            .map_err(|e| anyhow::anyhow!("Failed to get recent blockhash for SOL wrapping: {}", e))?;
        
        match crate::core::tx::new_signed_and_send_zeroslot(
            app_state.zeroslot_rpc_client.clone(),
            recent_blockhash,
            &app_state.wallet,
            instructions,
            logger,
        ).await {
            Ok(signatures) => {
                if !signatures.is_empty() {
                    logger.log(format!("SOL wrapped successfully, signature: {}", signatures[0]));
                    Ok(())
                } else {
                    Err(anyhow::anyhow!("No transaction signature returned"))
                }
            },
            Err(e) => {
                Err(anyhow::anyhow!("Failed to wrap SOL: {}", e))
            }
        }
    }
    
    /// Perform manual balance check and sell (for testing/debugging)
    pub async fn manual_balance_check(&self) -> Result<()> {
        self.logger.log("🔧 Performing manual balance check...".yellow().to_string());
        
        Self::perform_balance_check_and_sell(&self.app_state, &self.balance_manager, &self.logger).await
    }
    
    /// Get service status
    pub async fn get_status(&self) -> (bool, Duration) {
        let running = self.is_running().await;
        (running, self.monitoring_interval)
    }
}

impl Clone for BalanceMonitorService {
    fn clone(&self) -> Self {
        Self::new(self.app_state.clone())
    }
}
