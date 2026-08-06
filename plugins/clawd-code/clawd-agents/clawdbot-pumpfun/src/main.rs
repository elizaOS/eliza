/*
 * Copy Trading Bot with PumpSwap Notification Mode, Jupiter Integration, and Risk Management
 * 
 * Features:
 * - Modified PumpSwap buy/sell logic to only send notifications without executing transactions
 * - Transaction processing now runs in separate tokio tasks to ensure main monitoring continues
 * - Added placeholder for future selling strategy implementation
 * - PumpFun protocol functionality remains unchanged
 * - Added caching and batch RPC calls for improved performance
 * - Added --balance command to check and manage SOL/WSOL balance
 * - NEW: Automated risk management system with target wallet monitoring
 * 
 * Usage Commands:
 * - cargo run -- --wrap       : Wrap SOL to WSOL (amount from WRAP_AMOUNT env var)
 * - cargo run -- --unwrap     : Unwrap WSOL back to SOL
 * - cargo run -- --close      : Close all empty token accounts
 * - cargo run -- --buy <mint> <amount> : Buy token using PumpFun protocol
 * - cargo run -- --balance    : Check and manage SOL/WSOL balance
 * - cargo run -- --check-tokens : Check token tracking status
 * - cargo run -- --risk-check : Run manual risk management check (NEW!)
 * - cargo run                  : Start copy trading bot with risk management
 * 
 * PumpFun Integration:
 * The --buy command performs the following operations:
 * 1. Takes a token mint address and SOL amount as input
 * 2. Creates a swap configuration for buying
 * 3. Uses PumpFun protocol to build the swap transaction
 * 4. Signs and executes the transaction via RPC
 * 5. Returns the transaction signature for confirmation
 * 
 * The --balance command performs SOL/WSOL balance management:
 * 1. Checks current SOL and WSOL balances
 * 2. Calculates if rebalancing is needed (default: 20% deviation from 50/50 split)
 * 3. Automatically wraps SOL to WSOL or unwraps WSOL to SOL as needed
 * 4. Ensures optimal balance for both Pump.fun (SOL) and other DEXes (WSOL)
 * 
 * Environment Variables:
 * - WRAP_AMOUNT: Amount of SOL to wrap (default: 0.1)
 * - RISK_MANAGEMENT_ENABLED: Enable/disable risk management (default: true)
 * - RISK_TARGET_TOKEN_THRESHOLD: Token threshold for risk alerts (default: 1000)
 * 
 * Balance Management:
 * The system automatically maintains optimal SOL/WSOL ratios for different DEXes:
 * - Pump.fun requires native SOL for trading
 * - Other DEXes (Raydium, etc.) require WSOL for trading
 * - Default target: 50% SOL / 50% WSOL with 20% deviation threshold
 * - Triggered manually via --balance
 * - RISK_CHECK_INTERVAL_MINUTES: Risk check interval in minutes (default: 10)
 * - Standard bot configuration variables (RPC URLs, wallet keys, etc.)
 * 
 * Risk Management:
 * The bot automatically monitors target wallet token balances every 10 minutes.
 * If any target wallet has less than 1000 tokens (configurable) of any held token,
 * the system clears caches and resumes monitoring. This protects against following wallets that dump tokens.
 * 
 */

use anchor_client::solana_sdk::signature::Signer;
use solana_vntr_sniper::{
    common::{config::Config, constants::RUN_MSG, cache::WALLET_TOKEN_ACCOUNTS},
    engine::{
        copy_trading::{start_copy_trading, CopyTradingConfig},
        swap::SwapProtocol,
    },
    services::{balance_monitor::BalanceMonitorService},
    core::token,
};
use solana_program_pack::Pack;
use anchor_client::solana_sdk::pubkey::Pubkey;
use anchor_client::solana_sdk::transaction::{Transaction, VersionedTransaction};
use anchor_client::solana_sdk::system_instruction;
use std::str::FromStr;
use colored::Colorize;
use spl_token::instruction::sync_native;
use spl_token::ui_amount_to_amount;
use spl_associated_token_account::get_associated_token_address;
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use reqwest;
use std::collections::HashMap;
use base64;
use tokio::time::{sleep, Duration};

// Constants
const SOL_MINT: &str = "So11111111111111111111111111111111111111112";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const DEFAULT_CLAWD_TOKEN_ADDRESS: &str = "8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump";

/// Initialize the wallet token account list by fetching all token accounts owned by the wallet
async fn initialize_token_account_list(config: &Config) {
    let logger = solana_vntr_sniper::common::logger::Logger::new("[INIT-TOKEN-ACCOUNTS] => ".green().to_string());
    
    if let Ok(wallet_pubkey) = config.app_state.wallet.try_pubkey() {
        logger.log(format!("Initializing token account list for wallet: {}", wallet_pubkey));
        
        // Get the token program pubkey
        let token_program = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap();
        
        // Query all token accounts owned by the wallet
        let accounts = config.app_state.rpc_client.get_token_accounts_by_owner(
            &wallet_pubkey,
            anchor_client::solana_client::rpc_request::TokenAccountsFilter::ProgramId(token_program)
        );
        match accounts {
            Ok(accounts) => {
                logger.log(format!("Found {} token accounts", accounts.len()));
                
                // Add each token account to our global cache
                for account in accounts {
                    WALLET_TOKEN_ACCOUNTS.insert(Pubkey::from_str(&account.pubkey).unwrap());
                    logger.log(format!("Added token account: {}", account.pubkey ));
                }
                
                logger.log(format!("Token account list initialized with {} accounts", WALLET_TOKEN_ACCOUNTS.size()));
            },
            Err(e) => {
                logger.log(format!("Error fetching token accounts: {}", e));
            }
        }
    } else {
        logger.log("Failed to get wallet pubkey, can't initialize token account list".to_string());
    }
}

/// Wrap SOL to Wrapped SOL (WSOL)
async fn wrap_sol(config: &Config, amount: f64) -> Result<(), String> {
    let logger = solana_vntr_sniper::common::logger::Logger::new("[WRAP-SOL] => ".green().to_string());
    
    // Get wallet pubkey
    let wallet_pubkey = match config.app_state.wallet.try_pubkey() {
        Ok(pk) => pk,
        Err(_) => return Err("Failed to get wallet pubkey".to_string()),
    };
    
    // Create WSOL account instructions
    let (wsol_account, mut instructions) = match token::create_wsol_account(wallet_pubkey) {
        Ok(result) => result,
        Err(e) => return Err(format!("Failed to create WSOL account: {}", e)),
    };
    
    logger.log(format!("WSOL account address: {}", wsol_account));
    
    // Convert UI amount to lamports (1 SOL = 10^9 lamports)
    let lamports = ui_amount_to_amount(amount, 9);
    logger.log(format!("Wrapping {} SOL ({} lamports)", amount, lamports));
    
    // Transfer SOL to the WSOL account
    instructions.push(
        system_instruction::transfer(
            &wallet_pubkey,
            &wsol_account,
            lamports,
        )
    );
    
    // Sync native instruction to update the token balance
    instructions.push(
        sync_native(
            &spl_token::id(),
            &wsol_account,
        ).map_err(|e| format!("Failed to create sync native instruction: {}", e))?
    );
    
    // Send transaction using zeroslot for minimal latency
    let recent_blockhash = match config.app_state.rpc_client.get_latest_blockhash() {
        Ok(hash) => hash,
        Err(e) => return Err(format!("Failed to get recent blockhash for SOL wrapping: {}", e)),
    };
    
    match solana_vntr_sniper::core::tx::new_signed_and_send_zeroslot(
        config.app_state.zeroslot_rpc_client.clone(),
        recent_blockhash,
        &config.app_state.wallet,
        instructions,
        &logger,
    ).await {
        Ok(signatures) => {
            if !signatures.is_empty() {
                logger.log(format!("SOL wrapped successfully, signature: {}", signatures[0]));
                Ok(())
            } else {
                Err("No transaction signature returned".to_string())
            }
        },
        Err(e) => {
            Err(format!("Failed to wrap SOL: {}", e))
        }
    }
}

/// Unwrap SOL from Wrapped SOL (WSOL) account
async fn unwrap_sol(config: &Config) -> Result<(), String> {
    let logger = solana_vntr_sniper::common::logger::Logger::new("[UNWRAP-SOL] => ".green().to_string());
    
    // Get wallet pubkey
    let wallet_pubkey = match config.app_state.wallet.try_pubkey() {
        Ok(pk) => pk,
        Err(_) => return Err("Failed to get wallet pubkey".to_string()),
    };
    
    // Get the WSOL ATA address
    let wsol_account = get_associated_token_address(
        &wallet_pubkey,
        &spl_token::native_mint::id()
    );
    
    logger.log(format!("WSOL account address: {}", wsol_account));
    
    // Check if WSOL account exists
    match config.app_state.rpc_client.get_account(&wsol_account) {
        Ok(_) => {
            logger.log(format!("Found WSOL account: {}", wsol_account));
        },
        Err(_) => {
            return Err(format!("WSOL account does not exist: {}", wsol_account));
        }
    }
    
    // Close the WSOL account to recover SOL
    let close_instruction = token::close_account(
        wallet_pubkey,
        wsol_account,
        wallet_pubkey,
        wallet_pubkey,
        &[&wallet_pubkey],
    ).map_err(|e| format!("Failed to create close account instruction: {}", e))?;
    
    // Send transaction using zeroslot for minimal latency
    let recent_blockhash = match config.app_state.rpc_client.get_latest_blockhash() {
        Ok(hash) => hash,
        Err(e) => return Err(format!("Failed to get recent blockhash for SOL unwrapping: {}", e)),
    };
    
    match solana_vntr_sniper::core::tx::new_signed_and_send_zeroslot(
        config.app_state.zeroslot_rpc_client.clone(),
        recent_blockhash,
        &config.app_state.wallet,
        vec![close_instruction],
        &logger,
    ).await {
        Ok(signatures) => {
            if !signatures.is_empty() {
                logger.log(format!("WSOL unwrapped successfully, signature: {}", signatures[0]));
                Ok(())
            } else {
                Err("No transaction signature returned".to_string())
            }
        },
        Err(e) => {
            Err(format!("Failed to unwrap WSOL: {}", e))
        }
    }
}

/// Close all token accounts owned by the wallet
async fn close_all_token_accounts(config: &Config) -> Result<(), String> {
    let logger = solana_vntr_sniper::common::logger::Logger::new("[CLOSE-TOKEN-ACCOUNTS] => ".green().to_string());
    
    // Get wallet pubkey
    let wallet_pubkey = match config.app_state.wallet.try_pubkey() {
        Ok(pk) => pk,
        Err(_) => return Err("Failed to get wallet pubkey".to_string()),
    };
    
    // Get the token program pubkey
    let token_program = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap();
    
    // Query all token accounts owned by the wallet
    let accounts = config.app_state.rpc_client.get_token_accounts_by_owner(
        &wallet_pubkey,
        anchor_client::solana_client::rpc_request::TokenAccountsFilter::ProgramId(token_program)
    ).map_err(|e| format!("Failed to get token accounts: {}", e))?;
    
    if accounts.is_empty() {
        logger.log("No token accounts found to close".to_string());
        return Ok(());
    }
    
    logger.log(format!("Found {} token accounts to close", accounts.len()));
    
    let mut closed_count = 0;
    let mut failed_count = 0;
    
    // Close each token account
    for account_info in accounts {
        let token_account = Pubkey::from_str(&account_info.pubkey)
            .map_err(|_| format!("Invalid token account pubkey: {}", account_info.pubkey))?;
        
        // Skip WSOL accounts with non-zero balance (these need to be unwrapped first)
        let account_data = match config.app_state.rpc_client.get_account(&token_account) {
            Ok(data) => data,
            Err(e) => {
                logger.log(format!("Failed to get account data for {}: {}", token_account, e).red().to_string());
                failed_count += 1;
                continue;
            }
        };
        
        // Check if this is a WSOL account with balance
        if let Ok(token_data) = spl_token::state::Account::unpack(&account_data.data) {
            if token_data.mint == spl_token::native_mint::id() && token_data.amount > 0 {
                logger.log(format!("Skipping WSOL account with non-zero balance: {} ({})", 
                                 token_account, 
                                 token_data.amount as f64 / 1_000_000_000.0));
                continue;
            }
        }
        
        // Create close instruction
        let close_instruction = token::close_account(
            wallet_pubkey,
            token_account,
            wallet_pubkey,
            wallet_pubkey,
            &[&wallet_pubkey],
        ).map_err(|e| format!("Failed to create close instruction for {}: {}", token_account, e))?;
        
        // Send transaction using normal RPC for token account closing
        let recent_blockhash = match config.app_state.rpc_client.get_latest_blockhash() {
            Ok(hash) => hash,
            Err(e) => return Err(format!("Failed to get recent blockhash for token account {}: {}", token_account, e)),
        };
        
        match solana_vntr_sniper::core::tx::new_signed_and_send_normal(
            config.app_state.rpc_nonblocking_client.clone(),
            recent_blockhash,
            &config.app_state.wallet,
            vec![close_instruction],
            &logger,
        ).await {
            Ok(signatures) => {
                if !signatures.is_empty() {
                    logger.log(format!("Closed token account {}, signature: {}", token_account, signatures[0]));
                    closed_count += 1;
                } else {
                    logger.log(format!("Failed to close token account {}: No signature returned", token_account).red().to_string());
                    failed_count += 1;
                }
            },
            Err(e) => {
                logger.log(format!("Failed to close token account {}: {}", token_account, e).red().to_string());
                failed_count += 1;
            }
        }
    }
    
    logger.log(format!("Closed {} token accounts, {} failed", closed_count, failed_count));
    
    if failed_count > 0 {
        Err(format!("Failed to close {} token accounts", failed_count))
    } else {
        Ok(())
    }
}

/// Initialize target wallet token list by fetching all token accounts owned by the target wallet
async fn initialize_target_wallet_token_list(config: &Config, target_addresses: &[String]) -> Result<(), String> {
    let logger = solana_vntr_sniper::common::logger::Logger::new("[INIT-TARGET-TOKENS] => ".green().to_string());
    
    // Check if we should initialize
    let should_check = std::env::var("IS_CHECK_TARGET_WALLET_TOKEN_ACCOUNT")
        .ok()
        .and_then(|v| v.parse::<bool>().ok())
        .unwrap_or(false);
        
    if !should_check {
        logger.log("Skipping target wallet token check as IS_CHECK_TARGET_WALLET_TOKEN_ACCOUNT is not true".to_string());
        return Ok(());
    }
    
    // Get the token program pubkey
    let token_program = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap();
    
    for target_address in target_addresses {
        // Parse target wallet address
        let target_pubkey = match Pubkey::from_str(target_address) {
            Ok(pk) => pk,
            Err(e) => {
                logger.log(format!("Invalid target address {}: {}", target_address, e).red().to_string());
                continue;
            }
        };
        
        // Query all token accounts owned by the target wallet
        match config.app_state.rpc_client.get_token_accounts_by_owner(
            &target_pubkey,
            anchor_client::solana_client::rpc_request::TokenAccountsFilter::ProgramId(token_program)
        ) {
            Ok(accounts) => {
                logger.log(format!("Found {} token accounts for target {}", accounts.len(), target_address));
                
                // Add each token's mint to our global cache
                for account in accounts {
                    if let Ok(token_account) = config.app_state.rpc_client.get_account(&Pubkey::from_str(&account.pubkey).unwrap()) {
                        if let Ok(parsed) = spl_token::state::Account::unpack(&token_account.data) {
                            solana_vntr_sniper::common::cache::TARGET_WALLET_TOKENS.insert(parsed.mint.to_string());
                            logger.log(format!("Added token mint {} to target wallet list", parsed.mint));
                        }
                    }
                }
            },
            Err(e) => {
                logger.log(format!("Error fetching token accounts for target {}: {}", target_address, e).red().to_string());
            }
        }
    }
    
    logger.log(format!(
        "Target wallet token list initialized with {} tokens",
        solana_vntr_sniper::common::cache::TARGET_WALLET_TOKENS.size()
    ));
    
    Ok(())
}


/// Buy a token using PumpFun protocol
async fn buy_token(config: &Config, mint: &str, amount_sol: f64) -> Result<String, String> {
    let logger = solana_vntr_sniper::common::logger::Logger::new(format!("[BUY-TOKEN] {} => ", mint).green().to_string());
    
    logger.log(format!("Buying {} SOL worth of token {}", amount_sol, mint));
    
    let mint_pubkey = Pubkey::from_str(mint)
        .map_err(|e| format!("Invalid mint address {}: {}", mint, e))?;
    let pump = solana_vntr_sniper::dex::pump_fun::Pump::new(
        config.app_state.rpc_nonblocking_client.clone(),
        config.app_state.rpc_client.clone(),
        config.app_state.wallet.clone(),
    );
    let (keypair, instructions, price) = match pump
        .build_buy_v2_from_mint(mint_pubkey, amount_sol, config.swap_config.slippage)
        .await
    {
        Ok(result) => result,
        Err(e) if e.to_string().contains("Bonding curve complete; use PumpSwap") => {
            logger.log("Pump curve complete; falling back to PumpSwap pool".yellow().to_string());
            let (_, curve_state) = pump
                .get_curve_state_for_mint(&mint_pubkey)
                .await
                .map_err(|err| format!("Failed to fetch curve state for PumpSwap fallback: {}", err))?;
            let pump_swap = solana_vntr_sniper::dex::pump_swap::PumpSwap::new(
                config.app_state.wallet.clone(),
                Some(config.app_state.rpc_client.clone()),
                Some(config.app_state.rpc_nonblocking_client.clone()),
            );
            pump_swap
                .build_buy_from_mint(
                    mint_pubkey,
                    amount_sol,
                    config.swap_config.slippage,
                    curve_state.creator,
                )
                .await
                .map_err(|err| format!("Failed to build PumpSwap fallback buy: {}", err))?
        }
        Err(e) => return Err(format!("Failed to build buy_v2 swap: {}", e)),
    };
    logger.log(format!("Estimated spot price: {:.12} SOL", price));
    
    // Get recent blockhash
    let recent_blockhash = match config.app_state.rpc_client.get_latest_blockhash() {
        Ok(hash) => hash,
        Err(e) => return Err(format!("Failed to get recent blockhash: {}", e)),
    };
    
    match solana_vntr_sniper::core::tx::new_signed_and_send_with_landing_mode(
        config.transaction_landing_mode.clone(),
        &config.app_state,
        recent_blockhash,
        keypair.as_ref(),
        instructions,
        &logger,
    ).await {
        Ok(signatures) => {
            if !signatures.is_empty() {
                logger.log(format!("Token bought successfully! Signature: {}", signatures[0]));
                Ok(signatures[0].to_string())
            } else {
                Err("No transaction signature returned".to_string())
            }
        },
        Err(e) => {
            Err(format!("Failed to buy token: {}", e))
        }
    }
}

// ─── Control-file IPC ────────────────────────────────────────────────────────
// The frontend writes /tmp/clawd-bot-control.json; we read it every iteration.

const BOT_CONTROL_PATH: &str = "/tmp/clawd-bot-control.json";

#[derive(serde::Deserialize, Clone, Default)]
#[serde(default)]
struct BotControlState {
    /// "normal" | "volume" | "stopped"
    mode: String,
    #[serde(rename = "volumeAmountSol")]
    volume_amount_sol: Option<f64>,
    #[serde(rename = "volumeIntervalSeconds")]
    volume_interval_seconds: Option<u64>,
    #[serde(rename = "volumeBurstCount")]
    volume_burst_count: Option<u64>,
    #[serde(rename = "volumeBurstPauseSeconds")]
    volume_burst_pause_seconds: Option<u64>,
}

fn read_bot_control() -> BotControlState {
    let path = std::env::var("BOT_CONTROL_FILE")
        .unwrap_or_else(|_| BOT_CONTROL_PATH.to_string());
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn env_flag(key: &str, default: bool) -> bool {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<bool>().ok())
        .unwrap_or(default)
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default)
}

fn env_f64(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(default)
}

async fn run_autobuy_loop(config: &Config) -> Result<(), String> {
    let logger = solana_vntr_sniper::common::logger::Logger::new("[AUTO-BUY] => ".green().to_string());
    let token_address = std::env::var("TOKEN_ADDRESS")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CLAWD_TOKEN_ADDRESS.to_string());
    let amount_sol = env_f64("AUTO_BUY_AMOUNT_SOL", config.swap_config.amount_in);
    let interval_seconds = env_u64("AUTO_BUY_INTERVAL_SECONDS", 60);
    let startup_delay_seconds = env_u64("AUTO_BUY_STARTUP_DELAY_SECONDS", 0);
    let max_buys = env_u64("AUTO_BUY_MAX_BUYS", 0);

    logger.log(format!(
        "Starting automated buys for {} using RPC_HTTP with amount {} SOL every {}s",
        token_address, amount_sol, interval_seconds
    ));

    if startup_delay_seconds > 0 {
        logger.log(format!("Waiting {}s before first buy", startup_delay_seconds));
        sleep(Duration::from_secs(startup_delay_seconds)).await;
    }

    let mut executed_buys = 0_u64;
    let mut burst_buys_this_cycle = 0_u64;

    loop {
        let ctrl = read_bot_control();

        // ── Stopped mode: pause without exiting ──────────────────────────────
        if ctrl.mode == "stopped" {
            logger.log("Paused via control file (mode=stopped). Sleeping 5s…".yellow().to_string());
            sleep(Duration::from_secs(5)).await;
            continue;
        }

        // ── Determine effective params ────────────────────────────────────────
        let (effective_amount, effective_interval, burst_count, burst_pause) =
            if ctrl.mode == "volume" {
                let va = ctrl.volume_amount_sol.unwrap_or(amount_sol * 0.5_f64);
                let vi = ctrl.volume_interval_seconds.unwrap_or(
                    (interval_seconds / 6).max(5)
                );
                let bc = ctrl.volume_burst_count.unwrap_or(5);
                let bp = ctrl.volume_burst_pause_seconds.unwrap_or(60);
                logger.log(
                    format!("[VOLUME] {}SOL every {}s  (burst {}/{}s pause)",
                        va, vi, bc, bp)
                    .cyan().bold().to_string()
                );
                (va, vi, bc, bp)
            } else {
                burst_buys_this_cycle = 0;
                (amount_sol, interval_seconds, 0, 0)
            };

        // ── Execute buy ───────────────────────────────────────────────────────
        match buy_token(config, &token_address, effective_amount).await {
            Ok(signature) => {
                executed_buys += 1;
                burst_buys_this_cycle += 1;
                logger.log(format!(
                    "Auto-buy #{} ({}) confirmed: {}",
                    executed_buys, ctrl.mode, signature
                ));
            }
            Err(err) => {
                logger.log(format!("Auto-buy failed: {}", err).red().to_string());
            }
        }

        if max_buys > 0 && executed_buys >= max_buys {
            logger.log(format!("Reached AUTO_BUY_MAX_BUYS={}", max_buys));
            break;
        }

        // ── Volume burst pause ────────────────────────────────────────────────
        if ctrl.mode == "volume" && burst_count > 0 && burst_buys_this_cycle >= burst_count {
            logger.log(
                format!("[VOLUME] Burst of {} done. Pausing {}s…", burst_count, burst_pause)
                    .yellow().to_string()
            );
            burst_buys_this_cycle = 0;
            sleep(Duration::from_secs(burst_pause)).await;
        } else {
            sleep(Duration::from_secs(effective_interval)).await;
        }
    }

    Ok(())
}

#[tokio::main]
async fn main() {
    /* Initial Settings */
    let config = Config::new().await;
    let config = config.lock().await;

    /* Running Bot */
    let run_msg = RUN_MSG;
    println!("{}", run_msg);
    

    // Parse command line arguments
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 {
        // Check for command line arguments
        if args.contains(&"--wrap".to_string()) {
            println!("Wrapping SOL to WSOL...");
            
            // Get wrap amount from .env
            let wrap_amount = std::env::var("WRAP_AMOUNT")
                .ok()
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(0.1);
            
            match wrap_sol(&config, wrap_amount).await {
                Ok(_) => {
                    println!("Successfully wrapped {} SOL to WSOL", wrap_amount);
                    return;
                },
                Err(e) => {
                    eprintln!("Failed to wrap SOL: {}", e);
                    return;
                }
            }
        } else if args.contains(&"--unwrap".to_string()) {
            println!("Unwrapping WSOL to SOL...");
            
            match unwrap_sol(&config).await {
                Ok(_) => {
                    println!("Successfully unwrapped WSOL to SOL");
                    return;
                },
                Err(e) => {
                    eprintln!("Failed to unwrap WSOL: {}", e);
                    return;
                }
            }
        } else if args.contains(&"--close".to_string()) {
            println!("Closing all token accounts...");
            
            match close_all_token_accounts(&config).await {
                Ok(_) => {
                    println!("Successfully closed all token accounts");
                    return;
                },
                Err(e) => {
                    eprintln!("Failed to close all token accounts: {}", e);
                    return;
                }
            }
        } else if args.contains(&"--check-tokens".to_string()) {
            println!("Checking token tracking status...");
            
            let token_monitor = solana_vntr_sniper::services::token_monitor::TokenMonitor::new(
                Arc::new(config.app_state.clone())
            );
            
            let summary = token_monitor.get_tracking_summary();
            println!("{}", summary);
            return;
        } else if args.contains(&"--buy".to_string()) {
            // Get token mint and amount from command line
            if args.len() < 4 {
                eprintln!("Usage: --buy <mint_address> <amount_sol>");
                return;
            }
            
            let mint_address = &args[2];
            let amount_sol = match args[3].parse::<f64>() {
                Ok(amount) => amount,
                Err(_) => {
                    eprintln!("Invalid amount. Please provide a valid SOL amount.");
                    return;
                }
            };
            
            println!("Buying {} SOL worth of token {}", amount_sol, mint_address);
            match buy_token(&config, mint_address, amount_sol).await {
                Ok(signature) => {
                    println!("Successfully bought token! Signature: {}", signature);
                    return;
                },
                Err(e) => {
                    eprintln!("Failed to buy token: {}", e);
                    return;
                }
            }
        } else if args.contains(&"--balance".to_string()) {
            println!("Checking and managing SOL/WSOL balance...");
            
            use solana_vntr_sniper::services::balance_manager::BalanceManager;
            let balance_manager = BalanceManager::new(Arc::new(config.app_state.clone()));
            
            match balance_manager.get_current_balances().await {
                Ok(balance_info) => {
                    println!("Current balances:");
                    println!("  SOL:   {:.6}", balance_info.sol_balance);
                    println!("  WSOL:  {:.6}", balance_info.wsol_balance);
                    println!("  Total: {:.6}", balance_info.total_balance);
                    println!("  Ratio: {:.2}", balance_info.balance_ratio);
                    
                    if balance_manager.needs_rebalancing(&balance_info) {
                        println!("\nRebalancing needed! Performing automatic rebalancing...");
                        match balance_manager.rebalance().await {
                            Ok(_) => println!("✅ Rebalancing completed successfully!"),
                            Err(e) => eprintln!("❌ Rebalancing failed: {}", e),
                        }
                    } else {
                        println!("\n✅ Balances are well balanced - no action needed");
                    }
                    return;
                },
                Err(e) => {
                    eprintln!("Failed to check balances: {}", e);
                    return;
                }
            }
        } else if args.contains(&"--risk-check".to_string()) {
            println!("Running manual risk management check...");
            
            // Seller-bot: use our own wallet as the only target address
            let wallet_pubkey_str = match config.app_state.wallet.try_pubkey() {
                Ok(pk) => pk.to_string(),
                Err(e) => {
                    eprintln!("Failed to get wallet pubkey: {}", e);
                    return;
                }
            };
            let target_addresses = vec![wallet_pubkey_str];
            
            let risk_service = solana_vntr_sniper::services::risk_management::RiskManagementService::new(
                Arc::new(config.app_state.clone()),
                target_addresses
            );
            
            match risk_service.manual_risk_check().await {
                Ok(_) => {
                    println!("Risk check completed successfully!");
                    return;
                },
                Err(e) => {
                    eprintln!("Risk check failed: {}", e);
                    return;
                }
            }
        }

        if args.contains(&"--autobuy".to_string()) {
            match run_autobuy_loop(&config).await {
                Ok(_) => return,
                Err(e) => {
                    eprintln!("Autobuy loop failed: {}", e);
                    return;
                }
            }
        }
    }

    if env_flag("AUTO_BUY_ENABLED", false) {
        match run_autobuy_loop(&config).await {
            Ok(_) => return,
            Err(e) => {
                eprintln!("Autobuy loop failed: {}", e);
                return;
            }
        }
    }


    
    // Initialize token account list
    initialize_token_account_list(&config).await;

    // Seller-bot mode: subscribe to our own wallet pubkey
    let wallet_pubkey_str = match config.app_state.wallet.try_pubkey() {
        Ok(pk) => pk.to_string(),
        Err(e) => {
            eprintln!("Failed to get wallet pubkey: {}", e);
            return;
        }
    };
    let target_addresses = vec![wallet_pubkey_str];
    let excluded_addresses: Vec<String> = vec![];
    
    // Get protocol preference from environment
    let protocol_preference = std::env::var("PROTOCOL_PREFERENCE")
        .ok()
        .map(|p| match p.to_lowercase().as_str() {
            "pumpfun" => SwapProtocol::PumpFun,
            "pumpswap" => SwapProtocol::PumpSwap,
            "raydium_launchpad" => SwapProtocol::RaydiumLaunchpad,
            _ => SwapProtocol::Auto,
        })
        .unwrap_or(SwapProtocol::Auto);
    
    // Read WAIT_TIME from .env (seconds)
    let wait_time_seconds = std::env::var("WAIT_TIME")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(3);

    // Create seller-bot config
    let copy_trading_config = CopyTradingConfig {
        yellowstone_grpc_http: config.yellowstone_grpc_http.clone(),
        yellowstone_grpc_token: config.yellowstone_grpc_token.clone(),
        app_state: config.app_state.clone(),
        swap_config: config.swap_config.clone(),
        target_addresses: target_addresses.clone(),
        excluded_addresses,
        protocol_preference,
        min_dev_buy: 0.001, // Default value since this field is not in Config
        max_dev_buy: 0.1, // Default value since this field is not in Config
        transaction_landing_mode: config.transaction_landing_mode.clone(),
        wait_time_seconds,
    };
    
    
    // Create and start the balance monitoring service
    let balance_monitor_service = BalanceMonitorService::new(
        Arc::new(config.app_state.clone())
    );
    
    // Start balance monitoring service in background
    let balance_monitor_clone = balance_monitor_service.clone();
    tokio::spawn(async move {
        if let Err(e) = balance_monitor_clone.start_monitoring().await {
            eprintln!("Balance monitoring error: {}", e);
        }
    });
    
    println!("Balance monitoring service started (checking every 2 minutes with must-selling)");
    
    // Start the copy trading bot
    if let Err(e) = start_copy_trading(copy_trading_config).await {
        eprintln!("Copy trading error: {}", e);
    }
}
