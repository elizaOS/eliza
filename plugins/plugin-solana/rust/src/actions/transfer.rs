#![allow(missing_docs)]

use rust_decimal::Decimal;
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use tracing::{error, info};

use crate::client::SolanaClient;

#[derive(Debug, Clone)]
pub struct TransferActionResult {
    pub success: bool,
    pub text: String,
    pub signature: Option<String>,
    pub amount: Option<String>,
    pub recipient: Option<String>,
    pub error: Option<String>,
}

pub struct TransferAction;

impl TransferAction {
    pub const NAME: &'static str = "TRANSFER_SOLANA";

    pub const DESCRIPTION: &'static str =
        "Transfer SOL or SPL tokens to another address on Solana.";

    pub const SIMILES: &'static [&'static str] = &[
        "TRANSFER_SOL",
        "SEND_TOKEN_SOLANA",
        "TRANSFER_TOKEN_SOLANA",
        "SEND_TOKENS_SOLANA",
        "TRANSFER_TOKENS_SOLANA",
        "SEND_SOL",
        "SEND_TOKEN_SOL",
        "PAY_SOL",
        "PAY_TOKEN_SOL",
        "PAY_TOKENS_SOL",
        "PAY_TOKENS_SOLANA",
        "PAY_SOLANA",
    ];

    pub fn validate(client: &SolanaClient) -> bool {
        !client.public_key().to_string().is_empty()
    }

    pub async fn handle_sol_transfer(
        client: &SolanaClient,
        recipient: &str,
        amount: Decimal,
    ) -> TransferActionResult {
        info!("Executing SOL transfer: {} SOL to {}", amount, recipient);

        let recipient_pubkey = match Pubkey::from_str(recipient) {
            Ok(pk) => pk,
            Err(_) => {
                return TransferActionResult {
                    success: false,
                    text: format!("Invalid recipient address: {}", recipient),
                    signature: None,
                    amount: None,
                    recipient: None,
                    error: Some("Invalid recipient address".to_string()),
                };
            }
        };

        match client.transfer_sol(&recipient_pubkey, amount).await {
            Ok(result) => {
                let text = format!(
                    "Sent {} SOL. Transaction hash: {}",
                    amount,
                    result.signature.as_deref().unwrap_or("unknown")
                );

                info!("SOL transfer successful: {:?}", result);

                TransferActionResult {
                    success: true,
                    text,
                    signature: result.signature,
                    amount: Some(amount.to_string()),
                    recipient: Some(recipient.to_string()),
                    error: None,
                }
            }
            Err(e) => {
                error!("SOL transfer failed: {}", e);
                TransferActionResult {
                    success: false,
                    text: format!("Transfer failed: {}", e),
                    signature: None,
                    amount: None,
                    recipient: None,
                    error: Some(e.to_string()),
                }
            }
        }
    }

    pub async fn handle_token_transfer(
        client: &SolanaClient,
        token_mint: &str,
        recipient: &str,
        amount: Decimal,
    ) -> TransferActionResult {
        info!(
            "Executing token transfer: {} of {} to {}",
            amount, token_mint, recipient
        );

        let mint_pubkey = match Pubkey::from_str(token_mint) {
            Ok(pk) => pk,
            Err(_) => {
                return TransferActionResult {
                    success: false,
                    text: format!("Invalid token mint address: {}", token_mint),
                    signature: None,
                    amount: None,
                    recipient: None,
                    error: Some("Invalid token mint address".to_string()),
                };
            }
        };

        let recipient_pubkey = match Pubkey::from_str(recipient) {
            Ok(pk) => pk,
            Err(_) => {
                return TransferActionResult {
                    success: false,
                    text: format!("Invalid recipient address: {}", recipient),
                    signature: None,
                    amount: None,
                    recipient: None,
                    error: Some("Invalid recipient address".to_string()),
                };
            }
        };

        match client
            .transfer_token(&mint_pubkey, &recipient_pubkey, amount)
            .await
        {
            Ok(result) => {
                let text = format!(
                    "Sent {} tokens to {}\nTransaction hash: {}",
                    amount,
                    recipient,
                    result.signature.as_deref().unwrap_or("unknown")
                );

                info!("Token transfer successful: {:?}", result);

                TransferActionResult {
                    success: true,
                    text,
                    signature: result.signature,
                    amount: Some(amount.to_string()),
                    recipient: Some(recipient.to_string()),
                    error: None,
                }
            }
            Err(e) => {
                error!("Token transfer failed: {}", e);
                TransferActionResult {
                    success: false,
                    text: format!("Transfer failed: {}", e),
                    signature: None,
                    amount: None,
                    recipient: None,
                    error: Some(e.to_string()),
                }
            }
        }
    }

    pub async fn handle(
        client: &SolanaClient,
        token_mint: Option<&str>,
        recipient: &str,
        amount: Decimal,
    ) -> TransferActionResult {
        match token_mint {
            Some(mint) => Self::handle_token_transfer(client, mint, recipient, amount).await,
            None => Self::handle_sol_transfer(client, recipient, amount).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_action_metadata() {
        assert_eq!(TransferAction::NAME, "TRANSFER_SOLANA");
        assert!(!TransferAction::DESCRIPTION.is_empty());
        assert!(!TransferAction::SIMILES.is_empty());
        assert!(TransferAction::SIMILES.contains(&"SEND_SOL"));
    }
}
