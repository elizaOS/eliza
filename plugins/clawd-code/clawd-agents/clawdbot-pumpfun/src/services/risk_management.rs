use std::sync::Arc;
use std::time::Duration;
use tokio::time;
use anyhow::Result;
use anchor_client::solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use colored::Colorize;
use spl_associated_token_account::get_associated_token_address;
use reqwest;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use base64;
use anchor_client::solana_sdk::transaction::{Transaction, VersionedTransaction};
use anchor_client::solana_sdk::signature::Signer;
use anchor_client::solana_sdk::instruction::Instruction;

use crate::common::{
    config::AppState,
    logger::Logger,
    cache::BOUGHT_TOKENS,
};

// Jupiter API structures (duplicated from main.rs for modularity)
#[derive(Debug, Serialize, Deserialize)]
pub struct JupiterQuoteResponse {
    #[serde(rename = "inputMint")]
    pub input_mint: String,
    #[serde(rename = "inAmount")]
    pub in_amount: String,
    #[serde(rename = "outputMint")]
    pub output_mint: String,
    #[serde(rename = "outAmount")]
    pub out_amount: String,
    #[serde(rename = "otherAmountThreshold")]
    pub other_amount_threshold: String,
    #[serde(rename = "swapMode")]
    pub swap_mode: String,
    #[serde(rename = "slippageBps")]
    pub slippage_bps: u16,
    #[serde(rename = "priceImpactPct")]
    pub price_impact_pct: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PrioritizationFeeLamports {
    #[serde(rename = "priorityLevelWithMaxLamports")]
    pub priority_level_with_max_lamports: PriorityLevelWithMaxLamports,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PriorityLevelWithMaxLamports {
    #[serde(rename = "maxLamports")]
    pub max_lamports: u64,
    #[serde(rename = "priorityLevel")]
    pub priority_level: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JupiterSwapRequest {
    #[serde(rename = "quoteResponse")]
    pub quote_response: JupiterQuoteResponse,
    #[serde(rename = "userPublicKey")]
    pub user_public_key: String,
    #[serde(rename = "wrapAndUnwrapSol")]
    pub wrap_and_unwrap_sol: bool,
    #[serde(rename = "dynamicComputeUnitLimit")]
    pub dynamic_compute_unit_limit: bool,
    #[serde(rename = "prioritizationFeeLamports")]
    pub prioritization_fee_lamports: PrioritizationFeeLamports,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JupiterSwapResponse {
    #[serde(rename = "swapTransaction")]
    pub swap_transaction: String,
}

// Constants
const SOL_MINT: &str = "So11111111111111111111111111111111111111112";
pub const JUPITER_API_URL: &str = "https://quote-api.jup.ag";

/// Risk management configuration
#[derive(Clone, Debug)]
pub struct RiskConfig {
    pub target_token_threshold: f64,
    pub check_interval_minutes: u64,
    pub enabled: bool,
}

impl Default for RiskConfig {
    fn default() -> Self {
        Self {
            target_token_threshold: 1000.0,
            check_interval_minutes: 10,
            enabled: true,
        }
    }
}

impl RiskConfig {
    /// Create risk configuration from environment variables
    pub fn from_env() -> Self {
        let target_token_threshold = std::env::var("RISK_TARGET_TOKEN_THRESHOLD")
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(1000.0);
            
        let check_interval_minutes = std::env::var("RISK_CHECK_INTERVAL_MINUTES")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(10);
            
        let enabled = std::env::var("RISK_MANAGEMENT_ENABLED")
            .ok()
            .and_then(|v| v.parse::<bool>().ok())
            .unwrap_or(true);
        
        Self {
            target_token_threshold,
            check_interval_minutes,
            enabled,
        }
    }
}

/// Risk management service that monitors target address balances and sells tokens when risk threshold is met
#[derive(Clone)]
pub struct RiskManagementService {
    app_state: Arc<AppState>,
    logger: Logger,
    check_interval: Duration,
    target_addresses: Vec<String>,
    config: RiskConfig,
}

impl RiskManagementService {
    pub fn new(app_state: Arc<AppState>, target_addresses: Vec<String>) -> Self {
        let config = RiskConfig::from_env();
        
        Self {
            app_state,
            logger: Logger::new("[RISK-MANAGEMENT] => ".red().to_string()),
            check_interval: Duration::from_secs(config.check_interval_minutes * 60),
            target_addresses,
            config,
        }
    }
    
    /// Start the risk management monitoring service
    pub async fn start_monitoring(&self) -> Result<()> {
        if !self.config.enabled {
            self.logger.log("Risk management is disabled via RISK_MANAGEMENT_ENABLED=false".yellow().to_string());
            return Ok(());
        }
        
        self.logger.log(format!(
            "Starting risk management service (checking every {} minutes, threshold: {} tokens)...",
            self.config.check_interval_minutes,
            self.config.target_token_threshold
        ).green().to_string());
        
        loop {
            if let Err(e) = self.run_risk_check().await {
                self.logger.log(format!("Error during risk check: {}", e).red().to_string());
            }
            
            time::sleep(self.check_interval).await;
        }
    }
    
    /// Run a complete risk management check cycle
    async fn run_risk_check(&self) -> Result<()> {
        self.logger.log("=== Starting Risk Management Check ===".yellow().to_string());
        
        // Step 1: Check bought token balances
        let bought_tokens = BOUGHT_TOKENS.get_all_tokens();
        
        if bought_tokens.is_empty() {
            self.logger.log("No bought tokens to check".blue().to_string());
            return Ok(());
        }
        
        self.logger.log(format!("Checking {} bought tokens", bought_tokens.len()).blue().to_string());
        
        // Step 2: Check target address balances for each bought token
        let mut should_sell_all = false;
        
        for token_info in &bought_tokens {
            let target_has_low_balance = self.check_target_token_balance(&token_info.mint).await?;
            
            if target_has_low_balance {
                self.logger.log(format!(
                    "🚨 RISK ALERT: Target address has < {} tokens of {}", 
                    self.config.target_token_threshold, 
                    token_info.mint
                ).red().to_string());
                should_sell_all = true;
                break; // One token meeting criteria triggers sell all
            }
        }
        
        // Step 3: If risk threshold met, sell all tokens
        if should_sell_all {
            self.logger.log("🚨 RISK THRESHOLD MET - SELLING ALL TOKENS".red().to_string());
            
            if let Err(e) = self.sell_all_bought_tokens().await {
                self.logger.log(format!("Failed to sell all tokens: {}", e).red().to_string());
                return Err(anyhow::anyhow!("Risk management sell failed: {}", e));
            }
            
            // Step 4: Clear all caches
            self.clear_all_caches().await;
            
            // Step 5: Restart monitoring - this is handled by the main loop
            self.logger.log("✅ Risk management actions completed. Monitoring will restart.".green().to_string());
        } else {
            self.logger.log("✅ No risk threshold met. All target balances are healthy.".green().to_string());
        }
        
        Ok(())
    }
    
    /// Check if target address has low balance for a specific token
    async fn check_target_token_balance(&self, token_mint: &str) -> Result<bool> {
        let mint_pubkey = Pubkey::from_str(token_mint)?;
        
        for target_address in &self.target_addresses {
            let target_pubkey = match Pubkey::from_str(target_address) {
                Ok(pk) => pk,
                Err(e) => {
                    self.logger.log(format!("Invalid target address {}: {}", target_address, e).yellow().to_string());
                    continue;
                }
            };
            
            // Get target's token account for this mint
            let target_token_account = get_associated_token_address(&target_pubkey, &mint_pubkey);
            
            // Check token balance
            match self.app_state.rpc_nonblocking_client.get_token_account(&target_token_account).await {
                Ok(Some(account)) => {
                    let amount_value = account.token_amount.amount.parse::<f64>()
                        .map_err(|e| anyhow::anyhow!("Failed to parse token amount: {}", e))?;
                    let decimal_amount = amount_value / 10f64.powi(account.token_amount.decimals as i32);
                    
                    self.logger.log(format!(
                        "Target {} balance for token {}: {} tokens",
                        target_address,
                        token_mint,
                        decimal_amount
                    ).cyan().to_string());
                    
                    if decimal_amount < self.config.target_token_threshold {
                        self.logger.log(format!(
                            "🚨 Target {} has low balance: {} < {} for token {}",
                            target_address,
                            decimal_amount,
                            self.config.target_token_threshold,
                            token_mint
                        ).red().to_string());
                        return Ok(true);
                    }
                },
                Ok(None) => {
                    self.logger.log(format!(
                        "Target {} has no token account for {} (balance = 0)",
                        target_address,
                        token_mint
                    ).yellow().to_string());
                    // No token account means balance is 0, which is < threshold
                    return Ok(true);
                },
                Err(e) => {
                    self.logger.log(format!(
                        "Error checking target {} balance for token {}: {}",
                        target_address,
                        token_mint,
                        e
                    ).red().to_string());
                    // Treat errors as potential risk
                    return Ok(true);
                }
            }
        }
        
        Ok(false)
    }
    
    /// Sell all bought tokens using Jupiter API
    async fn sell_all_bought_tokens(&self) -> Result<()> {
        let bought_tokens = BOUGHT_TOKENS.get_all_tokens();
        
        if bought_tokens.is_empty() {
            self.logger.log("No tokens to sell".blue().to_string());
            return Ok(());
        }
        
        self.logger.log(format!("Selling {} bought tokens using Jupiter API", bought_tokens.len()).red().to_string());
        
        let wallet_pubkey = self.app_state.wallet.try_pubkey()
            .map_err(|_| anyhow::anyhow!("Failed to get wallet pubkey"))?;
        
        let mut successful_sales = 0;
        let mut failed_sales = 0;
        
        for token_info in &bought_tokens {
            // Skip SOL/WSOL
            if token_info.mint == SOL_MINT {
                continue;
            }
            
            self.logger.log(format!("Selling token: {} (amount: {})", token_info.mint, token_info.amount).magenta().to_string());
            
            match self.sell_single_token(token_info, &wallet_pubkey).await {
                Ok(signature) => {
                    self.logger.log(format!("✅ Successfully sold {}: {}", token_info.mint, signature).green().to_string());
                    successful_sales += 1;
                    
                    // Remove from tracking after successful sale
                    BOUGHT_TOKENS.remove_token(&token_info.mint);
                },
                Err(e) => {
                    self.logger.log(format!("❌ Failed to sell {}: {}", token_info.mint, e).red().to_string());
                    failed_sales += 1;
                }
            }
            
            // Add delay between swaps to avoid rate limiting
            time::sleep(Duration::from_millis(1000)).await;
        }
        
        self.logger.log(format!(
            "🔄 Selling completed: ✅ {} successful, ❌ {} failed",
            successful_sales, failed_sales
        ).blue().to_string());
        
        if failed_sales > 0 {
            return Err(anyhow::anyhow!("Some token sales failed: {} out of {}", failed_sales, successful_sales + failed_sales));
        }
        
        Ok(())
    }
    
    /// Sell a single token using Jupiter API
    async fn sell_single_token(&self, token_info: &crate::common::cache::BoughtTokenInfo, wallet_pubkey: &Pubkey) -> Result<String> {
        // Get current token balance to ensure we have the latest amount
        let current_balance = match self.app_state.rpc_nonblocking_client.get_token_account(&token_info.token_account).await {
            Ok(Some(account)) => {
                let amount_value = account.token_amount.amount.parse::<u64>()
                    .map_err(|e| anyhow::anyhow!("Failed to parse token amount: {}", e))?;
                amount_value
            },
            Ok(None) => {
                return Err(anyhow::anyhow!("Token account not found"));
            },
            Err(e) => {
                return Err(anyhow::anyhow!("Failed to get token account: {}", e));
            }
        };
        
        if current_balance == 0 {
            return Err(anyhow::anyhow!("Token balance is zero"));
        }
        
        self.logger.log(format!("Current balance for {}: {} (raw amount)", token_info.mint, current_balance));
        
        // Get quote from Jupiter
        // Risk management simplified - no Jupiter integration
        Err(anyhow::anyhow!("Risk management sell not implemented"))
        
    }
    
    /// Get Jupiter quote for token swap
    async fn get_jupiter_quote(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
        slippage_bps: u16,
    ) -> Result<JupiterQuoteResponse> {
        self.logger.log(format!("Getting Jupiter quote: {} -> {} (amount: {})", input_mint, output_mint, amount));
        
        let client = reqwest::Client::new();
        let url = format!(
            "{}/v6/quote?inputMint={}&outputMint={}&amount={}&slippageBps={}",
            JUPITER_API_URL, input_mint, output_mint, amount, slippage_bps
        );
        
        let response = client.get(&url)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to get quote: {}", e))?;
        
        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!("Quote API returned status: {} - {}", status, error_text));
        }
        
        let quote: JupiterQuoteResponse = response.json()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to parse quote response: {}", e))?;
        
        self.logger.log(format!("Quote received: {} {} -> {} {}", 
                             quote.in_amount, input_mint, quote.out_amount, output_mint));
        
        Ok(quote)
    }
    
    /// Get Jupiter swap transaction
    async fn get_jupiter_swap_transaction(
        &self,
        quote: JupiterQuoteResponse,
        user_public_key: &str,
    ) -> Result<String> {
        self.logger.log("Getting swap transaction from Jupiter".to_string());
        
        let client = reqwest::Client::new();
        let url = format!("{}/v6/swap", JUPITER_API_URL);
        
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
        
        let response = client.post(&url)
            .json(&swap_request)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to get swap transaction: {}", e))?;
        
        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!("Swap API returned status: {} - {}", status, error_text));
        }
        
        let swap_response: JupiterSwapResponse = response.json()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to parse swap response: {}", e))?;
        
        self.logger.log("Swap transaction received from Jupiter".to_string());
        Ok(swap_response.swap_transaction)
    }
    
    /// Execute Jupiter swap transaction
    async fn execute_swap_transaction(&self, swap_transaction_base64: &str) -> Result<String> {
        self.logger.log("Executing swap transaction".to_string());
        
        // Decode the base64 transaction
        let transaction_bytes = base64::decode(swap_transaction_base64)
            .map_err(|e| anyhow::anyhow!("Failed to decode transaction: {}", e))?;
        
        // Try to deserialize as versioned transaction first (Jupiter v6 primarily uses versioned transactions)
        if let Ok(mut transaction) = bincode::deserialize::<VersionedTransaction>(&transaction_bytes) {
            self.logger.log("Processing as versioned transaction".to_string());
            
            // Get recent blockhash
            let recent_blockhash = self.app_state.rpc_client.get_latest_blockhash()
                .map_err(|e| anyhow::anyhow!("Failed to get recent blockhash: {}", e))?;
            
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
                return Err(anyhow::anyhow!("Wallet not found in transaction account keys"));
            }
            
            // Send using RPC client directly with retry logic
            let mut attempts = 0;
            let max_attempts = 3;
            
            while attempts < max_attempts {
                attempts += 1;
                
                match self.app_state.rpc_client.send_transaction(&transaction) {
                    Ok(signature) => {
                        self.logger.log(format!("Versioned swap transaction sent: {}", signature));
                        
                        // Wait for confirmation
                        for _ in 0..30 { // Wait up to 30 seconds for confirmation
                            time::sleep(Duration::from_secs(1)).await;
                            
                            if let Ok(status) = self.app_state.rpc_client.get_signature_status(&signature) {
                                if let Some(result) = status {
                                    if result.is_ok() {
                                        self.logger.log(format!("Versioned swap transaction confirmed: {}", signature));
                                        return Ok(signature.to_string());
                                    } else {
                                        return Err(anyhow::anyhow!("Transaction failed: {:?}", result));
                                    }
                                }
                            }
                        }
                        
                        return Err(anyhow::anyhow!("Transaction confirmation timeout"));
                    },
                    Err(e) => {
                        self.logger.log(format!("Versioned swap attempt {}/{} failed: {}", attempts, max_attempts, e).red().to_string());
                        
                        if attempts >= max_attempts {
                            return Err(anyhow::anyhow!("All versioned swap attempts failed. Last error: {}", e));
                        }
                        
                        // Wait before retry
                        time::sleep(Duration::from_secs(2)).await;
                    }
                }
            }
        } else if let Ok(mut transaction) = bincode::deserialize::<Transaction>(&transaction_bytes) {
            self.logger.log("Processing as legacy transaction".to_string());
            
            // Get recent blockhash
            let recent_blockhash = self.app_state.rpc_client.get_latest_blockhash()
                .map_err(|e| anyhow::anyhow!("Failed to get recent blockhash: {}", e))?;
            
            // Update the transaction's blockhash
            transaction.message.recent_blockhash = recent_blockhash;
            
            // Sign the transaction
            transaction.sign(&[&self.app_state.wallet], recent_blockhash);
            
            // Send using RPC client directly with retry logic
            let mut attempts = 0;
            let max_attempts = 3;
            
            while attempts < max_attempts {
                attempts += 1;
                
                match self.app_state.rpc_client.send_transaction(&transaction) {
                    Ok(signature) => {
                        self.logger.log(format!("Swap transaction sent: {}", signature));
                        
                        // Wait for confirmation
                        for _ in 0..30 { // Wait up to 30 seconds for confirmation
                            time::sleep(Duration::from_secs(1)).await;
                            
                            if let Ok(status) = self.app_state.rpc_client.get_signature_status(&signature) {
                                if let Some(result) = status {
                                    if result.is_ok() {
                                        self.logger.log(format!("Swap transaction confirmed: {}", signature));
                                        return Ok(signature.to_string());
                                    } else {
                                        return Err(anyhow::anyhow!("Transaction failed: {:?}", result));
                                    }
                                }
                            }
                        }
                        
                        return Err(anyhow::anyhow!("Transaction confirmation timeout"));
                    },
                    Err(e) => {
                        self.logger.log(format!("Swap attempt {}/{} failed: {}", attempts, max_attempts, e).red().to_string());
                        
                        if attempts >= max_attempts {
                            return Err(anyhow::anyhow!("All swap attempts failed. Last error: {}", e));
                        }
                        
                        // Wait before retry
                        time::sleep(Duration::from_secs(2)).await;
                    }
                }
            }
        } else {
            // If we can't deserialize as either transaction type
            self.logger.log("Transaction format not supported - unable to deserialize as legacy or versioned transaction".yellow().to_string());
            return Err(anyhow::anyhow!("Unsupported transaction format - unable to deserialize as legacy or versioned transaction"));
        }

        
        Err(anyhow::anyhow!("Maximum retry attempts exceeded"))
    }
    
    /// Clear all caches and reset state
    async fn clear_all_caches(&self) {
        self.logger.log("🧹 Clearing all caches...".yellow().to_string());
        
        // Clear bought tokens cache
        BOUGHT_TOKENS.clear();
        self.logger.log("✅ Bought tokens cache cleared".green().to_string());
        
        // Clear other caches
        crate::common::cache::TOKEN_ACCOUNT_CACHE.clear_expired();
        crate::common::cache::TOKEN_MINT_CACHE.clear_expired();
        crate::common::cache::WALLET_TOKEN_ACCOUNTS.clear();
        crate::common::cache::TARGET_WALLET_TOKENS.clear();
        
        self.logger.log("✅ All caches cleared and reset".green().to_string());
    }
    
    /// Manual trigger for testing - runs a single risk check cycle
    pub async fn manual_risk_check(&self) -> Result<()> {
        self.logger.log("🔧 Manual risk check triggered".blue().to_string());
        self.run_risk_check().await
    }
    
    /// Get current configuration
    pub fn get_config(&self) -> &RiskConfig {
        &self.config
    }
} 
