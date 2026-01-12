//! SWAP_SOLANA action implementation.

use rust_decimal::Decimal;
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use tracing::{error, info};

use crate::client::SolanaClient;
use crate::types::SwapQuoteParams;
use crate::WRAPPED_SOL_MINT;

/// Result of a swap action.
#[derive(Debug, Clone)]
pub struct SwapActionResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Response text.
    pub text: String,
    /// Transaction signature if successful.
    pub signature: Option<String>,
    /// Input amount.
    pub in_amount: Option<String>,
    /// Output amount.
    pub out_amount: Option<String>,
    /// Error message if failed.
    pub error: Option<String>,
}

/// Swap Action for Solana.
///
/// Performs token swaps via Jupiter DEX aggregator.
pub struct SwapAction;

impl SwapAction {
    /// Action name.
    pub const NAME: &'static str = "SWAP_SOLANA";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Perform a token swap from one token to another on Solana. Works with SOL and SPL tokens.";

    /// Similar action names.
    pub const SIMILES: &'static [&'static str] = &[
        "SWAP_SOL",
        "SWAP_TOKENS_SOLANA",
        "TOKEN_SWAP_SOLANA",
        "TRADE_TOKENS_SOLANA",
        "EXCHANGE_TOKENS_SOLANA",
    ];

    /// Validate if the swap action can be executed.
    ///
    /// # Arguments
    ///
    /// * `client` - Reference to the Solana client.
    ///
    /// # Returns
    ///
    /// True if the client is properly configured.
    pub fn validate(client: &SolanaClient) -> bool {
        // Check that we have a valid public key configured
        !client.public_key().to_string().is_empty()
    }

    /// Execute the swap action.
    ///
    /// # Arguments
    ///
    /// * `client` - The Solana client.
    /// * `input_mint` - Input token mint address.
    /// * `output_mint` - Output token mint address.
    /// * `amount` - Amount to swap in token units.
    /// * `slippage_bps` - Slippage tolerance in basis points (default: 50 = 0.5%).
    ///
    /// # Returns
    ///
    /// The swap result.
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

        // Validate addresses
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

        // Calculate amount in lamports/smallest unit
        // For SOL and most SPL tokens, this is 9 decimals
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

        // Get quote
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

        // Execute swap
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

    /// Helper to resolve SOL symbol to wrapped SOL mint.
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
