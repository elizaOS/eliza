#![allow(missing_docs)]

use rust_decimal::Decimal;
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use tracing::{error, info};

use crate::client::SolanaClient;
use crate::types::SwapQuoteParams;
use crate::WRAPPED_SOL_MINT;

#[derive(Debug, Clone)]
pub struct SwapActionResult {
    pub success: bool,
    pub text: String,
    pub signature: Option<String>,
    pub in_amount: Option<String>,
    pub out_amount: Option<String>,
    pub error: Option<String>,
}

pub struct SwapAction;

impl SwapAction {
    pub const NAME: &'static str = "SWAP_SOLANA";
    pub const DESCRIPTION: &'static str =
        "Perform a token swap from one token to another on Solana. Works with SOL and SPL tokens.";
    pub const SIMILES: &'static [&'static str] = &[
        "SWAP_SOL",
        "SWAP_TOKENS_SOLANA",
        "TOKEN_SWAP_SOLANA",
        "TRADE_TOKENS_SOLANA",
        "EXCHANGE_TOKENS_SOLANA",
    ];

    pub fn validate(client: &SolanaClient) -> bool {
        !client.public_key().to_string().is_empty()
    }

    pub async fn handle(
        client: &SolanaClient,
        input_mint: &str,
        output_mint: &str,
        amount: Decimal,
        slippage_bps: Option<u16>,
    ) -> SwapActionResult {
        info!(
            "Executing swap: {} {} -> {}",
            amount, input_mint, output_mint
        );

        if Pubkey::from_str(input_mint).is_err() {
            return SwapActionResult {
                success: false,
                text: format!("Invalid input mint address: {}", input_mint),
                signature: None,
                in_amount: None,
                out_amount: None,
                error: Some("Invalid input mint address".to_string()),
            };
        }

        if Pubkey::from_str(output_mint).is_err() {
            return SwapActionResult {
                success: false,
                text: format!("Invalid output mint address: {}", output_mint),
                signature: None,
                in_amount: None,
                out_amount: None,
                error: Some("Invalid output mint address".to_string()),
            };
        }

        let decimals = 9;
        let amount_raw = (amount * Decimal::from(10u64.pow(decimals)))
            .to_string()
            .split('.')
            .next()
            .unwrap_or("0")
            .to_string();

        let quote_params = SwapQuoteParams {
            input_mint: input_mint.to_string(),
            output_mint: output_mint.to_string(),
            amount: amount_raw,
            slippage_bps: slippage_bps.unwrap_or(50),
        };

        let quote = match client.get_swap_quote(&quote_params).await {
            Ok(q) => q,
            Err(e) => {
                error!("Failed to get swap quote: {}", e);
                return SwapActionResult {
                    success: false,
                    text: format!("Failed to get swap quote: {}", e),
                    signature: None,
                    in_amount: None,
                    out_amount: None,
                    error: Some(e.to_string()),
                };
            }
        };

        match client.execute_swap(&quote).await {
            Ok(result) => {
                let text = if let Some(ref sig) = result.signature {
                    format!("Swap completed successfully! Transaction ID: {}", sig)
                } else {
                    "Swap completed successfully!".to_string()
                };

                info!("Swap successful: {:?}", result);

                SwapActionResult {
                    success: true,
                    text,
                    signature: result.signature,
                    in_amount: result.in_amount,
                    out_amount: result.out_amount,
                    error: None,
                }
            }
            Err(e) => {
                error!("Swap failed: {}", e);
                SwapActionResult {
                    success: false,
                    text: format!("Swap failed: {}", e),
                    signature: None,
                    in_amount: None,
                    out_amount: None,
                    error: Some(e.to_string()),
                }
            }
        }
    }

    pub fn resolve_sol_mint(symbol_or_mint: &str) -> &str {
        if symbol_or_mint.to_uppercase() == "SOL" {
            WRAPPED_SOL_MINT
        } else {
            symbol_or_mint
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_action_metadata() {
        assert_eq!(SwapAction::NAME, "SWAP_SOLANA");
        assert!(!SwapAction::DESCRIPTION.is_empty());
        assert!(!SwapAction::SIMILES.is_empty());
    }

    #[test]
    fn test_resolve_sol_mint() {
        assert_eq!(SwapAction::resolve_sol_mint("SOL"), WRAPPED_SOL_MINT);
        assert_eq!(SwapAction::resolve_sol_mint("sol"), WRAPPED_SOL_MINT);
        assert_eq!(
            SwapAction::resolve_sol_mint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        );
    }
}
