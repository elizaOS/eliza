//! # SOL/WSOL Balance Management System
//!
//! This module provides automatic balance management between native SOL and wrapped SOL (WSOL)
//! to ensure optimal trading across different DEXes in the Solana ecosystem.
//!
//! ## Problem Statement
//! - **Pump.fun** requires native SOL for trading
//! - **Other DEXes** (Raydium, etc.) require WSOL for trading
//! - After Jupiter selling, balances can become imbalanced, affecting trading efficiency
//!
//! ## Solution
//! The `BalanceManager` automatically monitors and rebalances SOL/WSOL to maintain optimal ratios.
//!
//! ## Usage Examples
//!
//! ### Basic Usage (Automatic after Jupiter selling)
//! ```rust
//! use crate::services::balance_manager::BalanceManager;
//!
//! // Create balance manager
//! let balance_manager = BalanceManager::new(app_state.clone());
//!
//! // This is automatically called after Jupiter sells
//! balance_manager.manage_balances_after_selling().await?;
//! ```
//!
//! ### Manual Balance Management
//! ```rust
//! // Create with custom settings (60% SOL, 40% WSOL, 15% deviation threshold)
//! let mut balance_manager = BalanceManager::new_with_settings(
//!     app_state.clone(),
//!     0.6,  // 60% SOL target
//!     0.15  // 15% deviation threshold
//! );
//!
//! // Check current balances
//! let balance_info = balance_manager.get_current_balances().await?;
//! println!("SOL: {:.6}, WSOL: {:.6}", balance_info.sol_balance, balance_info.wsol_balance);
//!
//! // Manual rebalancing
//! if balance_manager.needs_rebalancing(&balance_info) {
//!     balance_manager.rebalance().await?;
//! }
//! ```
//!
//! ### Configuration
//! ```rust
//! // Adjust target ratio (0.0 = all WSOL, 1.0 = all SOL)
//! balance_manager.set_target_ratio(0.7); // 70% SOL, 30% WSOL
//!
//! // Adjust rebalance sensitivity
//! balance_manager.set_rebalance_threshold(0.1); // Rebalance at 10% deviation
//! ```
//!
//! ## Integration Points
//! - **PeriodicSellerService**: Automatically triggered after periodic selling
//! - **SimpleSellingEngine**: Triggered after bulk Jupiter selling
//! - **Individual Jupiter sells**: Triggered after each successful sell
//!
//! ## Default Settings
//! - **Target Ratio**: 50% SOL / 50% WSOL
//! - **Rebalance Threshold**: 20% deviation from target
//! - **Minimum Balance**: 0.001 SOL total to trigger rebalancing

use std::sync::Arc;
use std::str::FromStr;
use anyhow::{anyhow, Result};
use colored::Colorize;
use anchor_client::solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    instruction::{AccountMeta, Instruction},
    system_program,
    sysvar,
};
use anchor_client::solana_client::nonblocking::rpc_client::RpcClient;
use spl_associated_token_account::{
    get_associated_token_address,
    instruction::create_associated_token_account_idempotent,
};
use spl_token::{
    instruction::{initialize_account, transfer, close_account, sync_native},
    state::Account as TokenAccount,
    ui_amount_to_amount,
};
use tokio::time::Duration;

use crate::common::{config::AppState, logger::Logger};

const SOL_MINT: &str = "So11111111111111111111111111111111111111112";
const WSOL_DECIMALS: u8 = 9;

/// Balance information for SOL and WSOL
#[derive(Debug, Clone)]
pub struct BalanceInfo {
    pub sol_balance: f64,      // Native SOL balance
    pub wsol_balance: f64,     // Wrapped SOL balance  
    pub total_balance: f64,    // Combined balance
    pub balance_ratio: f64,    // SOL / WSOL ratio
}

/// SOL/WSOL Balance Management Service
/// 
/// This service manages the balance between native SOL and wrapped SOL (WSOL)
/// to ensure optimal trading across different DEXes:
/// - Pump.fun requires native SOL
/// - Other DEXes (Raydium, etc.) require WSOL
/// 
/// The service automatically rebalances to maintain similar amounts of both
#[derive(Clone)]
pub struct BalanceManager {
    app_state: Arc<AppState>,
    rpc_client: Arc<RpcClient>,
    logger: Logger,
    target_ratio: f64,        // Target SOL:WSOL ratio (0.5 = 50/50 split)
    rebalance_threshold: f64, // Threshold to trigger rebalancing (0.2 = 20% deviation)
}

impl BalanceManager {
    /// Create a new balance manager
    pub fn new(app_state: Arc<AppState>) -> Self {
        Self {
            rpc_client: app_state.rpc_nonblocking_client.clone(),
            app_state,
            logger: Logger::new("[BALANCE-MANAGER] => ".cyan().to_string()),
            target_ratio: 0.5,    // 50/50 split by default
            rebalance_threshold: 0.2, // Rebalance if more than 20% deviation
        }
    }

    /// Create a new balance manager with custom settings
    pub fn new_with_settings(
        app_state: Arc<AppState>, 
        target_ratio: f64, 
        rebalance_threshold: f64
    ) -> Self {
        Self {
            rpc_client: app_state.rpc_nonblocking_client.clone(),
            app_state,
            logger: Logger::new("[BALANCE-MANAGER] => ".cyan().to_string()),
            target_ratio,
            rebalance_threshold,
        }
    }

    /// Get current SOL and WSOL balances
    pub async fn get_current_balances(&self) -> Result<BalanceInfo> {
        let wallet_pubkey = self.app_state.wallet.try_pubkey()
            .map_err(|_| anyhow!("Failed to get wallet pubkey"))?;

        // Get native SOL balance
        let sol_balance_lamports = self.rpc_client.get_balance(&wallet_pubkey).await?;
        let sol_balance = sol_balance_lamports as f64 / 1_000_000_000.0;

        // Get WSOL balance
        let wsol_mint = Pubkey::from_str(SOL_MINT)?;
        let wsol_ata = get_associated_token_address(&wallet_pubkey, &wsol_mint);
        
        let wsol_balance = match self.rpc_client.get_token_account_balance(&wsol_ata).await {
            Ok(balance) => balance.ui_amount.unwrap_or(0.0),
            Err(_) => 0.0, // WSOL account doesn't exist or is empty
        };

        let total_balance = sol_balance + wsol_balance;
        let balance_ratio = if wsol_balance > 0.0 { sol_balance / wsol_balance } else { f64::INFINITY };

        let balance_info = BalanceInfo {
            sol_balance,
            wsol_balance, 
            total_balance,
            balance_ratio,
        };

        self.logger.log(format!(
            "Current balances: SOL: {:.6}, WSOL: {:.6}, Total: {:.6}, Ratio: {:.2}",
            balance_info.sol_balance,
            balance_info.wsol_balance,
            balance_info.total_balance,
            balance_info.balance_ratio
        ).blue().to_string());

        Ok(balance_info)
    }

    /// Check if rebalancing is needed based on current balances
    pub fn needs_rebalancing(&self, balance_info: &BalanceInfo) -> bool {
        if balance_info.total_balance < 0.001 {
            // Skip if total balance is too small
            return false;
        }

        // Calculate current SOL percentage
        let current_sol_percentage = balance_info.sol_balance / balance_info.total_balance;
        let deviation = (current_sol_percentage - self.target_ratio).abs();
        
        let needs_rebalance = deviation > self.rebalance_threshold;
        
        if needs_rebalance {
            self.logger.log(format!(
                "Rebalancing needed: SOL%: {:.1}%, Target: {:.1}%, Deviation: {:.1}%",
                current_sol_percentage * 100.0,
                self.target_ratio * 100.0,
                deviation * 100.0
            ).yellow().to_string());
        }

        needs_rebalance
    }

    /// Perform automatic rebalancing between SOL and WSOL
    pub async fn rebalance(&self) -> Result<()> {
        let balance_info = self.get_current_balances().await?;
        
        if !self.needs_rebalancing(&balance_info) {
            self.logger.log("No rebalancing needed".green().to_string());
            return Ok(());
        }

        // Calculate target amounts
        let target_sol = balance_info.total_balance * self.target_ratio;
        let target_wsol = balance_info.total_balance * (1.0 - self.target_ratio);
        
        let sol_diff = target_sol - balance_info.sol_balance;
        let wsol_diff = target_wsol - balance_info.wsol_balance;

        self.logger.log(format!(
            "Rebalancing: Target SOL: {:.6} (diff: {:.6}), Target WSOL: {:.6} (diff: {:.6})",
            target_sol, sol_diff, target_wsol, wsol_diff
        ).blue().to_string());

        if sol_diff > 0.001 {
            // Need more SOL: unwrap WSOL -> SOL
            self.unwrap_wsol(sol_diff).await?;
        } else if wsol_diff > 0.001 {
            // Need more WSOL: wrap SOL -> WSOL  
            self.wrap_sol(wsol_diff).await?;
        }

        // Verify rebalancing
        let new_balance_info = self.get_current_balances().await?;
        self.logger.log(format!(
            "Rebalancing completed: SOL: {:.6} -> {:.6}, WSOL: {:.6} -> {:.6}",
            balance_info.sol_balance, new_balance_info.sol_balance,
            balance_info.wsol_balance, new_balance_info.wsol_balance
        ).green().to_string());

        Ok(())
    }

    /// Wrap SOL to WSOL
    async fn wrap_sol(&self, amount: f64) -> Result<()> {
        self.logger.log(format!("Wrapping {:.6} SOL to WSOL", amount).cyan().to_string());

        let wallet_pubkey = self.app_state.wallet.try_pubkey()
            .map_err(|_| anyhow!("Failed to get wallet pubkey"))?;
        
        let keypair = self.app_state.wallet.clone();
        let wsol_mint = Pubkey::from_str(SOL_MINT)?;
        let wsol_ata = get_associated_token_address(&wallet_pubkey, &wsol_mint);

        let amount_lamports = ui_amount_to_amount(amount, WSOL_DECIMALS);
        let mut instructions = Vec::new();

        // Create WSOL account if it doesn't exist
        instructions.push(create_associated_token_account_idempotent(
            &wallet_pubkey,
            &wallet_pubkey,
            &wsol_mint,
            &spl_token::id(),
        ));

        // Transfer SOL to WSOL account
        instructions.push(anchor_client::solana_sdk::system_instruction::transfer(
            &wallet_pubkey,
            &wsol_ata,
            amount_lamports,
        ));

        // Sync native (this converts the SOL to WSOL tokens)
        instructions.push(sync_native(&spl_token::id(), &wsol_ata)?);

        // Send transaction
        self.send_transaction(instructions, keypair).await?;
        
        self.logger.log(format!("Successfully wrapped {:.6} SOL to WSOL", amount).green().to_string());
        Ok(())
    }

    /// Unwrap WSOL to SOL
    async fn unwrap_wsol(&self, amount: f64) -> Result<()> {
        self.logger.log(format!("Unwrapping {:.6} WSOL to SOL", amount).cyan().to_string());

        let wallet_pubkey = self.app_state.wallet.try_pubkey()
            .map_err(|_| anyhow!("Failed to get wallet pubkey"))?;
            
        let keypair = self.app_state.wallet.clone();
        let wsol_mint = Pubkey::from_str(SOL_MINT)?;
        let wsol_ata = get_associated_token_address(&wallet_pubkey, &wsol_mint);

        // Check if WSOL account exists and has sufficient balance
        let wsol_balance = self.rpc_client.get_token_account_balance(&wsol_ata).await?;
        let current_wsol = wsol_balance.ui_amount.unwrap_or(0.0);
        
        if current_wsol < amount {
            return Err(anyhow!("Insufficient WSOL balance: {} < {}", current_wsol, amount));
        }

        let _amount_raw = ui_amount_to_amount(amount, WSOL_DECIMALS);
        let mut instructions = Vec::new();

        // Close the WSOL account (this unwraps WSOL back to SOL)
        instructions.push(close_account(
            &spl_token::id(),
            &wsol_ata,
            &wallet_pubkey,
            &wallet_pubkey,
            &[],
        )?);

        // Send transaction
        self.send_transaction(instructions, keypair).await?;
        
        self.logger.log(format!("Successfully unwrapped {:.6} WSOL to SOL", amount).green().to_string());
        Ok(())
    }

    /// Send a transaction with the given instructions
    async fn send_transaction(&self, instructions: Vec<Instruction>, signer: Arc<Keypair>) -> Result<()> {
        let recent_blockhash = self.rpc_client.get_latest_blockhash().await?;
        
        let transaction = anchor_client::solana_sdk::transaction::Transaction::new_signed_with_payer(
            &instructions,
            Some(&signer.pubkey()),
            &[&*signer],
            recent_blockhash,
        );

        let signature = self.rpc_client.send_and_confirm_transaction(&transaction).await?;
        
        self.logger.log(format!("Transaction sent: {}", signature).blue().to_string());
        Ok(())
    }

    /// Perform balance management after Jupiter selling
    /// This is the main function to be called after Jupiter sells tokens
    pub async fn manage_balances_after_selling(&self) -> Result<()> {
        self.logger.log("Starting SOL/WSOL balance management after Jupiter selling...".green().to_string());
        
        // Wait a bit for transactions to settle
        tokio::time::sleep(Duration::from_secs(3)).await;
        
        // Check current balances
        let balance_info = self.get_current_balances().await?;
        
        // Perform rebalancing if needed
        if self.needs_rebalancing(&balance_info) {
            self.rebalance().await?;
        } else {
            self.logger.log("Balances are already well balanced".green().to_string());
        }

        // Final balance check
        let final_balance = self.get_current_balances().await?;
        self.logger.log(format!(
            "Balance management completed. Final: SOL: {:.6}, WSOL: {:.6}",
            final_balance.sol_balance,
            final_balance.wsol_balance
        ).green().bold().to_string());

        Ok(())
    }

    /// Set custom target ratio (0.0 = all WSOL, 1.0 = all SOL, 0.5 = 50/50)
    pub fn set_target_ratio(&mut self, ratio: f64) {
        self.target_ratio = ratio.clamp(0.0, 1.0);
        self.logger.log(format!("Target ratio updated to: {:.1}% SOL / {:.1}% WSOL", 
            self.target_ratio * 100.0, (1.0 - self.target_ratio) * 100.0));
    }

    /// Set rebalance threshold (how much deviation triggers rebalancing)
    pub fn set_rebalance_threshold(&mut self, threshold: f64) {
        self.rebalance_threshold = threshold.clamp(0.01, 0.5); // 1% to 50%
        self.logger.log(format!("Rebalance threshold updated to: {:.1}%", self.rebalance_threshold * 100.0));
    }
} 