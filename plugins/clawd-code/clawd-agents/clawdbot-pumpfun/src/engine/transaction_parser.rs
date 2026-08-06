use bs58;
use std::str::FromStr;
use solana_sdk::pubkey::Pubkey;
use colored::Colorize;
use crate::common::logger::Logger;
use lazy_static;
use yellowstone_grpc_proto::geyser::SubscribeUpdateTransaction;
use std::time::Instant;
// Import PUMP_FUN_PROGRAM instead of PUMP_PROGRAM
use crate::dex::pump_fun::PUMP_FUN_PROGRAM;
// Create a static logger for this module
lazy_static::lazy_static! {
    static ref LOGGER: Logger = Logger::new("[PARSER] => ".blue().to_string());
}

#[derive(Clone, Debug, PartialEq)]
pub enum DexType {
    PumpSwap,
    PumpFun,
    RaydiumLaunchpad,
    Unknown,
}

#[derive(Clone, Debug)]
pub struct TradeInfoFromToken {
    // Common fields
    pub dex_type: DexType,
    pub slot: u64,
    pub signature: String,
    pub pool_id: String,
    pub mint: String,
    pub timestamp: u64,
    pub is_buy: bool,
    pub price: u64,
    pub is_reverse_when_pump_swap: bool,
    pub coin_creator: Option<String>,
    pub sol_change: f64,
    pub token_change: f64,
    pub liquidity: f64,  // this is for filtering out small trades
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
}
/// Helper function to check if transaction contains MintTo instruction
/// NOTE: This function is no longer used - we now process all transactions regardless of MintTo
fn _has_mint_to_instruction(txn: &SubscribeUpdateTransaction) -> bool {
    if let Some(tx_inner) = &txn.transaction {
        if let Some(meta) = &tx_inner.meta {
            // Check log messages for "Program log: Instruction: MintTo"
            return meta.log_messages.iter().any(|log| {
                log.contains("Program log: Instruction: MintTo")
            });
        }
    }
    false
}

/// Helper function to check if transaction contains Buy instruction
fn has_buy_instruction(txn: &SubscribeUpdateTransaction) -> bool {
    if let Some(tx_inner) = &txn.transaction {
        if let Some(meta) = &tx_inner.meta {
            return meta.log_messages.iter().any(|log| {
                log.contains("Program log: Instruction: Buy")
            });
        }
    }
    false
}

/// Helper function to check if transaction contains Sell instruction
fn has_sell_instruction(txn: &SubscribeUpdateTransaction) -> bool {
    if let Some(tx_inner) = &txn.transaction {
        if let Some(meta) = &tx_inner.meta {
            return meta.log_messages.iter().any(|log| {
                log.contains("Program log: Instruction: Sell")
            });
        }
    }
    false
}

/// Parses the transaction data buffer into a TradeInfoFromToken struct
pub fn parse_transaction_data(txn: &SubscribeUpdateTransaction, buffer: &[u8]) -> Option<TradeInfoFromToken> {
    fn parse_public_key(buffer: &[u8], offset: usize) -> Option<String> {
        if offset + 32 > buffer.len() {
            return None;
        }
        Some(bs58::encode(&buffer[offset..offset+32]).into_string())
    }

    fn parse_u64(buffer: &[u8], offset: usize) -> Option<u64> {
        if offset + 8 > buffer.len() {
            return None;
        }
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&buffer[offset..offset+8]);
        Some(u64::from_le_bytes(bytes))
    }

    fn parse_u8(buffer: &[u8], offset: usize) -> Option<u8> {
        if offset >= buffer.len() {
            return None;
        }
        Some(buffer[offset])
    }
    
    // Helper function to extract token mint from token balances
    fn extract_token_info(
        txn: &SubscribeUpdateTransaction,
    ) -> String {
        
        let mut mint = String::new();
        let mut is_reverse = false;
        
        // Try to extract from token balances if txn is available
        if let Some(tx_inner) = &txn.transaction {
            if let Some(meta) = &tx_inner.meta {
                // Find the first mint that is not WSOL
                if !meta.post_token_balances.is_empty() {
                    for token_balance in &meta.post_token_balances {
                        if token_balance.mint != "So11111111111111111111111111111111111111112" {
                            mint = token_balance.mint.clone();
                            break;
                        }
                    }
                }
            }
        }
        
        // If we couldn't extract from token balances, use default
        if mint.is_empty() {
            mint = "2ivzYvjnKqA4X3dVvPKr7bctGpbxwrXbbxm44TJCpump".to_string();
        }
        
        mint
    }
    
    // Check for MintTo instruction in transaction logs
    // NOTE: MintTo checking has been removed - we now process all transactions
    let _has_mint_to = _has_mint_to_instruction(txn);
    
    let start_time = Instant::now();
    match buffer.len() {

        368 => {  // pump swap transaction - 368 bytes
            // Extract token mint and check for reverse case
            let mint = extract_token_info(&txn);
            let timestamp = parse_u64(buffer, 16)?;
            let base_amount_in_or_base_amount_out = parse_u64(buffer, 24)?;
            let min_quote_amount_out = parse_u64(buffer, 32)?;
            let user_base_token_reserves = parse_u64(buffer, 40)?;
            let user_quote_token_reserves = parse_u64(buffer, 48)?;
            let pool_base_token_reserves = parse_u64(buffer, 56)?;
            let pool_quote_token_reserves = parse_u64(buffer, 64)?;
            let quote_amount_out = parse_u64(buffer, 72)?;
            let lp_fee_basis_points = parse_u64(buffer, 80)?;
            let lp_fee = parse_u64(buffer, 88)?;
            let protocol_fee_basis_points = parse_u64(buffer, 96)?;
            let protocol_fee = parse_u64(buffer, 104)?;
            let quote_amount_out_without_lp_fee = parse_u64(buffer, 112)?;
            let user_quote_amount_out = parse_u64(buffer, 120)?;
            let pool_id = parse_public_key(buffer, 128)?;
            let coin_creator = parse_public_key(buffer, 320)?;
            
            let (price , is_reverse_when_pump_swap) = if pool_base_token_reserves > 0 && pool_quote_token_reserves > 0 {
                // Calculate price and determine if it's reverse case
                let temp_price = pool_base_token_reserves.saturating_mul(1_000_000_000) / pool_quote_token_reserves.max(1);
                if temp_price < 1 {
                    // In reverse case: poolBaseTokenReserves/poolQuoteTokenReserves (base_mint is WSOL)
                    (temp_price, true)
                } else {
                    // Normal case: poolQuoteTokenReserves/poolBaseTokenReserves (quote_mint is WSOL)
                    let normal_price = pool_quote_token_reserves.saturating_mul(1_000_000_000) / pool_base_token_reserves.max(1);
                    (normal_price, false)
                }
            } else {
                // Normal case: poolQuoteTokenReserves/poolBaseTokenReserves (quote_mint is WSOL)
                (0, false)
            };
            
            let is_buy = if is_reverse_when_pump_swap {
                // In reverse case, buy and sell are inverted (base_mint is WSOL)
                has_sell_instruction(txn)
            } else {
                // Normal case (quote_mint is WSOL)
                has_buy_instruction(txn)
            };
            LOGGER.log(format!("PumpSwap=========== {}: {} SOL (Price: {}) Reverse: {}", 
                if is_buy { "BUY" } else { "SELL" },
                (quote_amount_out as f64) / 1.0, 
                price as f64 / 1.0,
                is_reverse_when_pump_swap
            ).green().to_string());
            
            let (sol_change, token_change) = if is_reverse_when_pump_swap {
              // Reverse case: base_mint is WSOL, quote_mint is token
              if is_buy {
                // Buy: spend SOL (base), get tokens (quote) 
                (-(base_amount_in_or_base_amount_out as f64) / 1_000_000_000.0, quote_amount_out as f64 / 1_000_000_000.0)
              } else {
                // Sell: get SOL (base), spend tokens (quote)
                (base_amount_in_or_base_amount_out as f64 / 1_000_000_000.0, -(quote_amount_out as f64) / 1_000_000_000.0)
              }
            } else {
                // Normal case: quote_mint is WSOL, base_mint is token
                if is_buy {
                    // Buy: spend SOL (quote), get tokens (base)
                    (-(quote_amount_out as f64) / 1_000_000_000.0, base_amount_in_or_base_amount_out as f64 / 1_000_000_000.0)
                } else {
                    // Sell: get SOL (quote), spend tokens (base)
                    (quote_amount_out as f64 / 1_000_000_000.0, -(base_amount_in_or_base_amount_out as f64) / 1_000_000_000.0)
                }
            };  

            let liquidity = if !is_reverse_when_pump_swap {
                pool_quote_token_reserves as f64 / 1_000_000_000.0
            } else {
                pool_base_token_reserves as f64 / 1_000_000_000.0
            };
            
            LOGGER.log(format!("PumpSwap {}: {} SOL (Price: {}) Reverse: {}", 
                if is_buy { "BUY" } else { "SELL" },
                (quote_amount_out as f64) / 1_000_000_000.0, 
                price as f64 / 1_000_000_000.0,
                is_reverse_when_pump_swap
            ).green().to_string());
            
            Some(TradeInfoFromToken {
                dex_type: DexType::PumpSwap,
                slot: 0, // Will be set from transaction data
                signature: String::new(), // Will be set from transaction data
                pool_id: pool_id.clone(),
                mint: mint.clone(),
                timestamp,
                is_buy,
                price,
                is_reverse_when_pump_swap,
                coin_creator: Some(coin_creator),
                sol_change,
                token_change,
                liquidity,
                // Map pool reserves to virtual reserves as requested
                virtual_sol_reserves: pool_quote_token_reserves,  
                virtual_token_reserves: pool_base_token_reserves,  
            })
        },

        270 => {  // pump swap migeration transaction - 270 bytes  
            // Extract token mint and check for reverse case
            let mint = extract_token_info(&txn);
            let timestamp = parse_u64(buffer, 16)?;
            let base_amount_in_or_base_amount_out = parse_u64(buffer, 24)?;
            let min_quote_amount_out = parse_u64(buffer, 32)?;
            let user_base_token_reserves = parse_u64(buffer, 40)?;
            let user_quote_token_reserves = parse_u64(buffer, 48)?;
            let pool_base_token_reserves = parse_u64(buffer, 56)?;
            let pool_quote_token_reserves = parse_u64(buffer, 64)?;
            let quote_amount_out = parse_u64(buffer, 72)?;
            let lp_fee_basis_points = parse_u64(buffer, 80)?;
            let lp_fee = parse_u64(buffer, 88)?;
            let protocol_fee_basis_points = parse_u64(buffer, 96)?;
            let protocol_fee = parse_u64(buffer, 104)?;
            let quote_amount_out_without_lp_fee = parse_u64(buffer, 112)?;
            let user_quote_amount_out = parse_u64(buffer, 120)?;
            let pool_id = parse_public_key(buffer, 128)?;
            
            // Determine if this is a reverse case by checking if the mint is WSOL
            let is_reverse_when_pump_swap = mint == "So11111111111111111111111111111111111111112";
            
            // Determine buy/sell based on reverse case and log messages
            let is_buy = if is_reverse_when_pump_swap {
                // In reverse case, buy and sell are inverted (base_mint is WSOL)
                has_sell_instruction(txn)
            } else {
                // Normal case (quote_mint is WSOL)
                has_buy_instruction(txn)
            };
            
            // Calculate price for PumpSwap
            let price = if pool_base_token_reserves > 0 && pool_quote_token_reserves > 0 {
                if is_reverse_when_pump_swap {
                    // In reverse case: poolBaseTokenReserves/poolQuoteTokenReserves (base_mint is WSOL)
                    pool_base_token_reserves.saturating_mul(1_000_000_000) / pool_quote_token_reserves.max(1)
                } else {
                    // Normal case: poolQuoteTokenReserves/poolBaseTokenReserves (quote_mint is WSOL)
                    pool_quote_token_reserves.saturating_mul(1_000_000_000) / pool_base_token_reserves.max(1)
                }
            } else {
                0
            };
            let (sol_change, token_change) = if is_reverse_when_pump_swap {
              // Reverse case: base_mint is WSOL, quote_mint is token
              if is_buy {
                // Buy: spend SOL (base), get tokens (quote) 
                (-(base_amount_in_or_base_amount_out as f64) / 1_000_000_000.0, quote_amount_out as f64 / 1_000_000_000.0)
              } else {
                // Sell: get SOL (base), spend tokens (quote)
                (base_amount_in_or_base_amount_out as f64 / 1_000_000_000.0, -(quote_amount_out as f64) / 1_000_000_000.0)
              }
            } else {
                // Normal case: quote_mint is WSOL, base_mint is token
                if is_buy {
                    // Buy: spend SOL (quote), get tokens (base)
                    (-(quote_amount_out as f64) / 1_000_000_000.0, base_amount_in_or_base_amount_out as f64 / 1_000_000_000.0)
                } else {
                    // Sell: get SOL (quote), spend tokens (base)
                    (quote_amount_out as f64 / 1_000_000_000.0, -(base_amount_in_or_base_amount_out as f64) / 1_000_000_000.0)
                }
            };  

            let liquidity = if !is_reverse_when_pump_swap {
                pool_quote_token_reserves as f64 / 1_000_000_000.0
            } else {
                pool_base_token_reserves as f64 / 1_000_000_000.0
            };
            
            LOGGER.log(format!("PumpSwap {}: {} SOL (Price: {}) Reverse: {}", 
                if is_buy { "BUY" } else { "SELL" },
                (quote_amount_out as f64) / 1_000_000_000.0, 
                price as f64 / 1_000_000_000.0,
                is_reverse_when_pump_swap
            ).green().to_string());
            
            Some(TradeInfoFromToken {
                dex_type: DexType::PumpSwap,
                slot: 0, // Will be set from transaction data
                signature: String::new(), // Will be set from transaction data
                pool_id: pool_id.clone(),
                mint: mint.clone(),
                timestamp,
                is_buy,
                price,
                is_reverse_when_pump_swap,
                coin_creator: None, // 270 byte format doesn't include coin creator
                sol_change,
                token_change,
                liquidity,
                // Map pool reserves to virtual reserves as requested
                virtual_sol_reserves: pool_quote_token_reserves,  
                virtual_token_reserves: pool_base_token_reserves,  
            })
        },

        266 => {
            // Parse PumpFunData fields
            let mint = parse_public_key(buffer, 16)?;
            let sol_amount = parse_u64(buffer, 48)?;
            let token_amount = parse_u64(buffer, 56)?;
            let is_buy = buffer.get(64)? == &1;
            let timestamp = parse_u64(buffer, 97)?;
            let virtual_sol_reserves = parse_u64(buffer, 105)?;
            let virtual_token_reserves = parse_u64(buffer, 113)?;
            let real_sol_reserves = parse_u64(buffer, 121)?;
            let real_token_reserves = parse_u64(buffer, 129)?;
            let creator = parse_public_key(buffer, 185)?;
            // Calculate price for PumpFun: virtualSolReserves/virtualTokenReserves
            let price = if virtual_token_reserves > 0 {
                virtual_sol_reserves.saturating_mul(1_000_000_000) / virtual_token_reserves
            } else {
                0
            };

            // Pump fun don't have pool, just have bonding curve
            let liquidity = real_sol_reserves as f64 / 1_000_000_000.0;

            if is_buy {
                LOGGER.log(format!("PumpFun BUY: {} SOL (Price: {})", 
                    (sol_amount as f64) / 1_000_000_000.0, 
                    price as f64 / 1_000_000_000.0
                ).green().to_string());
            } else {
                LOGGER.log(format!("PumpFun SELL: {} SOL (Price: {})", 
                    (sol_amount as f64) / 1_000_000_000.0, 
                    price as f64 / 1_000_000_000.0
                ).yellow().to_string());
            }
            
            Some(TradeInfoFromToken {
                dex_type: DexType::PumpFun,
                slot: 0, // Will be set from transaction data
                signature: String::new(), // Will be set from transaction data
                pool_id: String::new(),
                mint,
                timestamp,
                is_buy,
                price,
                is_reverse_when_pump_swap: false, // PumpFun is never reverse
                coin_creator: Some(creator),
                sol_change: sol_amount as f64 / 1_000_000_000.0,
                token_change: token_amount as f64 / 1_000_000_000.0,
                liquidity,
                virtual_sol_reserves: virtual_sol_reserves,
                virtual_token_reserves: virtual_token_reserves,
            })
        },
        
        155 => { // Raydium Launchpad - process all buy transactions
            let pool_id = parse_public_key(buffer, 16)?;
            let virtual_base_reserve = parse_u64(buffer, 56)?;
            let virtual_quote_reserve = parse_u64(buffer, 64)?;
            let real_base_before = parse_u64(buffer, 72)?;
            let real_quote_before = parse_u64(buffer, 80)?;
            let real_base_after = parse_u64(buffer, 88)?;
            let real_quote_after = parse_u64(buffer, 96)?;
            
            // Trade direction flag (1 for sell, 0 for buy)
            let trade_direction = parse_u8(buffer, 144)? == 1;
            let is_buy = !trade_direction; // Invert: 0 = buy, 1 = sell
            
            // For Raydium Launchpad, we don't need reverse logic since it's never reverse
            let mint = extract_token_info(&txn);
            let is_reverse_when_pump_swap = false;
            
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            
                       
            // Calculate actual sol_change and token_change based on before/after reserves
            let sol_change_amount = (real_quote_after as i64 - real_quote_before as i64) as f64 / 1_000_000_000.0;
            let token_change_amount = (real_base_after as i64 - real_base_before as i64) as f64 / 1_000_000_000.0;
            
            // Correct Raydium Launchpad price calculation formula
            // Price = (virtual_quote_reserve - real_quote_after) / (virtual_base_reserve - real_base_after)
            let price = if (virtual_base_reserve as f64 - real_base_after as f64) > 0.0 {
                let calculated_price = ((virtual_quote_reserve as f64 + real_quote_after as f64) / (virtual_base_reserve as f64 - real_base_after as f64)) * 1_000_000_000.0; // never change this formula without Deni's permission
                LOGGER.log(format!("Raydium Launchpad {}: Price calculation - virtual_quote: {}, real_quote_after: {}, virtual_base: {}, real_base_after: {}, calculated_price: {}", 
                    if is_buy { "BUY" } else { "SELL" },
                    virtual_quote_reserve, real_quote_after, virtual_base_reserve, real_base_after, calculated_price
                ).cyan().to_string());
                calculated_price as u64
            } else {
                LOGGER.log("Raydium Launchpad: Price calculation failed - division by zero".red().to_string());
                0u64
            };
            // For Raydium Launchpad:
            // - Buy: SOL decreases (negative), tokens increase (positive)
            // - Sell: SOL increases (positive), tokens decrease (negative)
            let (sol_change, token_change) = if is_buy {
                // Buy: we spend SOL, get tokens
                (-sol_change_amount.abs(), token_change_amount.abs())
            } else {
                // Sell: we get SOL, spend tokens
                (sol_change_amount.abs(), -token_change_amount.abs())
            };

            Some(TradeInfoFromToken {
                dex_type: DexType::RaydiumLaunchpad,
                slot: 0, // Will be set from transaction data
                signature: String::new(), // Will be set from transaction data
                pool_id: pool_id.clone(),
                mint: mint.clone(),
                timestamp,
                is_buy,
                price,
                is_reverse_when_pump_swap: false, // Raydium is never reverse
                coin_creator: None, // no need for raydium launchpad 
                sol_change,
                token_change,
                liquidity: real_quote_after as f64 / 1_000_000_000.0,
                virtual_sol_reserves: virtual_quote_reserve,
                virtual_token_reserves: virtual_base_reserve,
            })
        },
        _ => None,
    }
}
