use std::sync::Arc;
use std::str::FromStr;
use anyhow::{Result, anyhow};
use colored::Colorize;
use anchor_client::solana_client::nonblocking::rpc_client::RpcClient;
use anchor_client::solana_sdk::{
    instruction::Instruction,
    signature::Keypair,
    system_instruction,
    transaction::Transaction,
};
use std::env;
use anchor_client::solana_sdk::pubkey::Pubkey;
use spl_token::ui_amount_to_amount;
use solana_sdk::signature::Signer;
use tokio::time::{Instant, sleep};
use tokio::sync::Mutex;
use once_cell::sync::Lazy;
use reqwest::{Client, ClientBuilder};
use base64;
use bs58;
use std::time::Duration;
use crate::{
    common::{
        logger::Logger,
        config::TransactionLandingMode,
    },
    services::{
        zeroslot::{self, ZeroSlotClient},
    },
};
use dotenv::dotenv;

// prioritization fee = UNIT_PRICE * UNIT_LIMIT
fn get_unit_price() -> u64 {
    env::var("UNIT_PRICE")
        .ok()
        .and_then(|v| u64::from_str(&v).ok())
        .unwrap_or(20000)
}

fn get_unit_limit() -> u32 {
    env::var("UNIT_LIMIT")
        .ok()
        .and_then(|v| u32::from_str(&v).ok())
        .unwrap_or(200_000)
}


// Cache the FlashBlock API key
static FLASHBLOCK_API_KEY: Lazy<String> = Lazy::new(|| {
    std::env::var("FLASHBLOCK_API_KEY")
        .ok()
        .unwrap_or_else(|| "da07907679634859".to_string())
});

// Create a static HTTP client with optimized configuration for FlashBlock API
static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
   let client = reqwest::Client::new();
   client
});

pub async fn new_signed_and_send_zeroslot(
    zeroslot_rpc_client: Arc<crate::services::zeroslot::ZeroSlotClient>,
    recent_blockhash: solana_sdk::hash::Hash,
    keypair: &Keypair,
    mut instructions: Vec<Instruction>,
    logger: &Logger,
) -> Result<Vec<String>> {
    let tip_account = zeroslot::get_tip_account()?;
    let start_time = Instant::now();
    let mut txs: Vec<String> = vec![];
    
    // zeroslot tip, the upper limit is 0.1
    let tip = zeroslot::get_tip_value().await?;
    let tip_lamports = ui_amount_to_amount(tip, spl_token::native_mint::DECIMALS);

    let zeroslot_tip_instruction = 
        system_instruction::transfer(&keypair.pubkey(), &tip_account, tip_lamports);
        
        let unit_limit = get_unit_limit(); // TODO: update in mev boost
        let unit_price = get_unit_price(); // TODO: update in mev boost
        let modify_compute_units =
        solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(unit_limit);
        let add_priority_fee =
        solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_price(unit_price);
        instructions.insert(1, modify_compute_units);
        instructions.insert(2, add_priority_fee);
        
        instructions.push(zeroslot_tip_instruction); // zeroslot is different with others.
    // send init tx
    let txn = Transaction::new_signed_with_payer(
        &instructions,
        Some(&keypair.pubkey()),
        &vec![keypair],
        recent_blockhash,
    );

    let tx_result = zeroslot_rpc_client.send_transaction(&txn).await;
    
    match tx_result {
        Ok(signature) => {
            txs.push(signature.to_string());
            logger.log(
                format!("[TXN-ELAPSED(ZEROSLOT)]: {:?}", start_time.elapsed())
                    .yellow()
                    .to_string(),
            );
        }
        Err(_) => {
            // Convert the error to a Send-compatible form
            return Err(anyhow::anyhow!("zeroslot send_transaction failed"));
        }
    };

    Ok(txs)
}
/// Send transaction using normal RPC without any service or tips
pub async fn new_signed_and_send_normal(
    rpc_client: Arc<anchor_client::solana_client::nonblocking::rpc_client::RpcClient>,
    recent_blockhash: anchor_client::solana_sdk::hash::Hash,
    keypair: &Keypair,
    mut instructions: Vec<Instruction>,
    logger: &Logger,
) -> Result<Vec<String>> {
    let start_time = Instant::now();
    
    // Add compute budget instructions for priority fee
    // let unit_limit = 200000;
    // let unit_price = 20000;
    // let modify_compute_units =
    //     solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(unit_limit);
    // let add_priority_fee =
    //     solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_price(unit_price);
    // instructions.insert(0, modify_compute_units);
    // instructions.insert(1, add_priority_fee);
    
    // Create and send transaction
    let txn = Transaction::new_signed_with_payer(
        &instructions,
        Some(&keypair.pubkey()),
        &vec![keypair],
        recent_blockhash,
    );

    match rpc_client.send_transaction(&txn).await {
        Ok(signature) => {
            logger.log(
                format!("[TXN-ELAPSED(NORMAL)]: {:?}", start_time.elapsed())
                    .yellow()
                    .to_string(),
            );
            Ok(vec![signature.to_string()])
        }
        Err(e) => Err(anyhow!("Failed to send normal transaction: {}", e))
    }
}

/// Universal transaction landing function that routes to the appropriate service
pub async fn new_signed_and_send_with_landing_mode(
    transaction_landing_mode: TransactionLandingMode,
    app_state: &crate::common::config::AppState,
    recent_blockhash: anchor_client::solana_sdk::hash::Hash,
    keypair: &Keypair,
    instructions: Vec<Instruction>,
    logger: &Logger,
) -> Result<Vec<String>> {
    // Route to the appropriate service
    match transaction_landing_mode {
        TransactionLandingMode::Zeroslot => {
            logger.log("Using Zeroslot for transaction landing".green().to_string());
            new_signed_and_send_zeroslot(
                app_state.zeroslot_rpc_client.clone(),
                recent_blockhash,
                keypair,
                instructions,
                logger,
            ).await
        },
        TransactionLandingMode::Normal => {
            logger.log("Using Normal RPC for transaction landing".green().to_string());
            new_signed_and_send_normal(
                app_state.rpc_nonblocking_client.clone(),
                recent_blockhash,
                keypair,
                instructions,
                logger,
            ).await
        },
    }
}

