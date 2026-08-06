use std::sync::Arc;
use std::time::Duration;
use tokio::time;
use anyhow::Result;
use anchor_client::solana_sdk::pubkey::Pubkey;
use colored::Colorize;
use spl_associated_token_account::get_associated_token_address;

use crate::common::{
    config::AppState,
    logger::Logger,
    cache::BOUGHT_TOKENS,
};

/// Token monitoring service that periodically checks token balances
#[derive(Clone)]
pub struct TokenMonitor {
    app_state: Arc<AppState>,
    logger: Logger,
    check_interval: Duration,
}

impl TokenMonitor {
    pub fn new(app_state: Arc<AppState>) -> Self {
        Self {
            app_state,
            logger: Logger::new("[TOKEN-MONITOR] => ".cyan().to_string()),
            check_interval: Duration::from_secs(30), // Check every 30 seconds
        }
    }
    
    /// Start the token monitoring service
    pub async fn start_monitoring(&self) -> Result<()> {
        self.logger.log("Starting token monitoring service...".green().to_string());
        
        loop {
            if let Err(e) = self.check_all_token_balances().await {
                self.logger.log(format!("Error checking token balances: {}", e).red().to_string());
            }
            
            time::sleep(self.check_interval).await;
        }
    }
    
    /// Check balances for all tracked tokens
    async fn check_all_token_balances(&self) -> Result<()> {
        let bought_tokens = BOUGHT_TOKENS.get_all_tokens();
        
        if bought_tokens.is_empty() {
            return Ok(());
        }
        
        self.logger.log(format!("Checking balances for {} tracked tokens", bought_tokens.len()).blue().to_string());
        
        for token_info in bought_tokens {
            if let Err(e) = self.check_token_balance(&token_info).await {
                self.logger.log(format!("Error checking balance for token {}: {}", token_info.mint, e).red().to_string());
            }
        }
        
        Ok(())
    }
    
    /// Check balance for a specific token
    async fn check_token_balance(&self, token_info: &crate::common::cache::BoughtTokenInfo) -> Result<()> {
        // Get current token balance
        let current_balance = match self.app_state.rpc_nonblocking_client.get_token_account(&token_info.token_account).await {
            Ok(Some(account)) => {
                let amount_raw = account.token_amount.amount.parse::<u64>()
                    .map_err(|e| anyhow::anyhow!("Failed to parse token amount: {}", e))?;
                let amount_value = account.token_amount.amount.parse::<f64>()
                    .map_err(|e| anyhow::anyhow!("Failed to parse token amount: {}", e))?;
                let decimal_amount = amount_value / 10f64.powi(account.token_amount.decimals as i32);
                let decimals = account.token_amount.decimals;
                
                // Update both the tracked balance AND the cached balance for selling
                BOUGHT_TOKENS.update_token_balance(&token_info.mint, decimal_amount);
                BOUGHT_TOKENS.cache_verified_balance(&token_info.mint, amount_raw, decimal_amount, decimals);
                
                decimal_amount
            },
            Ok(None) => {
                // Token account doesn't exist, remove from tracking
                self.logger.log(format!("Token account not found for {}, removing from tracking", token_info.mint).yellow().to_string());
                BOUGHT_TOKENS.remove_token(&token_info.mint);
                return Ok(());
            },
            Err(e) => {
                return Err(anyhow::anyhow!("Failed to get token account: {}", e));
            }
        };
        
        // Log if balance changed significantly
        if (current_balance - token_info.amount).abs() > 0.01 {
            self.logger.log(format!(
                "Token {} balance updated: {} -> {}",
                token_info.mint,
                token_info.amount,
                current_balance
            ).blue().to_string());
        }
        
        // If balance is zero or very low, consider removing from tracking
        if current_balance <= 0.001 {
            self.logger.log(format!("Token {} has very low balance ({}), removing from tracking", token_info.mint, current_balance).yellow().to_string());
            BOUGHT_TOKENS.remove_token(&token_info.mint);
        }
        
        Ok(())
    }
    
    /// Get a summary of all tracked tokens
    pub fn get_tracking_summary(&self) -> String {
        let bought_tokens = BOUGHT_TOKENS.get_all_tokens();
        
        if bought_tokens.is_empty() {
            return "No tokens currently being tracked".to_string();
        }
        
        let mut summary = format!("Tracking {} tokens:\n", bought_tokens.len());
        
        for token_info in bought_tokens {
            let elapsed = token_info.buy_time.elapsed();
            let elapsed_str = if elapsed.as_secs() < 60 {
                format!("{}s", elapsed.as_secs())
            } else if elapsed.as_secs() < 3600 {
                format!("{}m", elapsed.as_secs() / 60)
            } else {
                format!("{}h", elapsed.as_secs() / 3600)
            };
            
            summary.push_str(&format!(
                "  • {}: {} tokens (bought {} ago via {})\n",
                token_info.mint,
                token_info.amount,
                elapsed_str,
                token_info.protocol
            ));
        }
        
        summary
    }
    
    /// Manually check a specific token balance
    pub async fn check_specific_token(&self, mint: &str) -> Result<()> {
        if let Some(token_info) = BOUGHT_TOKENS.get_token_info(mint) {
            self.check_token_balance(&token_info).await
        } else {
            Err(anyhow::anyhow!("Token {} not found in tracking", mint))
        }
    }
} 