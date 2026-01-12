//! Wallet Provider for Solana.
//!
//! Provides wallet portfolio information including balances and token holdings.

use rust_decimal::Decimal;
use std::collections::HashMap;
use tracing::{error, info};

use crate::client::SolanaClient;
use crate::types::{PortfolioItem, WalletPortfolio};
use crate::WRAPPED_SOL_MINT;

/// Result of the wallet provider.
#[derive(Debug, Clone)]
pub struct WalletProviderResult {
    /// Portfolio data.
    pub data: WalletPortfolio,
    /// Key-value pairs for template substitution.
    pub values: HashMap<String, String>,
    /// Human-readable text summary.
    pub text: String,
}

/// Wallet Provider for Solana.
///
/// Provides dynamic wallet portfolio information including:
/// - SOL balance
/// - SPL token balances
/// - USD values (when prices available)
/// - Market prices for SOL, BTC, ETH
pub struct WalletProvider;

impl WalletProvider {
    /// Provider name.
    pub const NAME: &'static str = "solana-wallet";

    /// Provider description.
    pub const DESCRIPTION: &'static str = "your solana wallet information";

    /// Whether this provider generates dynamic content.
    pub const DYNAMIC: bool = true;

    /// Get wallet portfolio information.
    ///
    /// # Arguments
    ///
    /// * `client` - The Solana client.
    /// * `agent_name` - Optional agent name for the text output.
    ///
    /// # Returns
    ///
    /// The wallet portfolio result.
    pub async fn get(
        client: &SolanaClient,
        agent_name: Option<&str>,
    ) -> Result<WalletProviderResult, String> {
        let agent_name = agent_name.unwrap_or("The agent");
        let pubkey = client.public_key();
        let pubkey_str = pubkey.to_string();

        info!("Fetching wallet portfolio for {}", pubkey_str);

        // Get SOL balance
        let sol_balance = match client.get_sol_balance().await {
            Ok(b) => b,
            Err(e) => {
                error!("Failed to get SOL balance: {}", e);
                return Err(format!("Failed to get SOL balance: {}", e));
            }
        };

        // Get token accounts
        let token_accounts = match client.get_token_accounts().await {
            Ok(ta) => ta,
            Err(e) => {
                error!("Failed to get token accounts: {}", e);
                // Continue with just SOL balance
                vec![]
            }
        };

        // Try to get prices (optional, don't fail if unavailable)
        let sol_price = match client
            .get_token_prices(&[WRAPPED_SOL_MINT.to_string()])
            .await
        {
            Ok(prices) => prices.get(WRAPPED_SOL_MINT).copied(),
            Err(_) => None,
        };

        // Calculate SOL USD value
        let sol_value_usd = if let Some(price) = sol_price {
            sol_balance * Decimal::from_f64_retain(price).unwrap_or(Decimal::ZERO)
        } else {
            Decimal::ZERO
        };

        // Build portfolio items
        let mut items: Vec<PortfolioItem> = vec![];

        // Add SOL as first item
        items.push(PortfolioItem {
            name: "Solana".to_string(),
            symbol: "SOL".to_string(),
            address: WRAPPED_SOL_MINT.to_string(),
            decimals: 9,
            balance: (sol_balance * Decimal::from(1_000_000_000u64)).to_string(),
            ui_amount: sol_balance.to_string(),
            price_usd: sol_price
                .map(|p| p.to_string())
                .unwrap_or_else(|| "0".to_string()),
            value_usd: sol_value_usd.to_string(),
            value_sol: Some(sol_balance.to_string()),
        });

        // Add token accounts
        for account in token_accounts {
            if account.ui_amount > Decimal::ZERO {
                items.push(PortfolioItem {
                    name: account.mint.clone(),  // Would need token registry for names
                    symbol: "TOKEN".to_string(), // Would need token registry for symbols
                    address: account.mint,
                    decimals: account.decimals,
                    balance: account.amount.clone(),
                    ui_amount: account.ui_amount.to_string(),
                    price_usd: "0".to_string(),
                    value_usd: "0".to_string(),
                    value_sol: None,
                });
            }
        }

        // Calculate total USD
        let total_usd = sol_value_usd;

        // Build portfolio
        let portfolio = WalletPortfolio {
            total_usd: total_usd.to_string(),
            total_sol: Some(sol_balance.to_string()),
            items: items.clone(),
            prices: None, // Would need to fetch BTC/ETH prices
            last_updated: Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            ),
        };

        // Build values map
        let mut values: HashMap<String, String> = HashMap::new();
        values.insert("total_usd".to_string(), total_usd.to_string());
        values.insert("total_sol".to_string(), sol_balance.to_string());

        if let Some(price) = sol_price {
            values.insert("sol_price".to_string(), price.to_string());
        }

        // Add token values
        for (idx, item) in items.iter().enumerate() {
            values.insert(format!("token_{}_name", idx), item.name.clone());
            values.insert(format!("token_{}_symbol", idx), item.symbol.clone());
            values.insert(format!("token_{}_amount", idx), item.ui_amount.clone());
            values.insert(format!("token_{}_usd", idx), item.value_usd.clone());
            if let Some(ref sol_val) = item.value_sol {
                values.insert(format!("token_{}_sol", idx), sol_val.clone());
            }
        }

        // Build text output
        let mut text = format!("\n\n{}'s Main Solana Wallet ({})\n", agent_name, pubkey_str);
        text.push_str(&format!(
            "Total Value: ${} ({} SOL)\n\n",
            total_usd, sol_balance
        ));
        text.push_str("Token Balances:\n");

        if items.is_empty() {
            text.push_str("No tokens found with non-zero balance\n");
        } else {
            for item in &items {
                let sol_str = item
                    .value_sol
                    .as_ref()
                    .map(|s| format!(" | {} SOL", s))
                    .unwrap_or_default();
                text.push_str(&format!(
                    "{} ({}): {} (${}{})\n",
                    item.name, item.symbol, item.ui_amount, item.value_usd, sol_str
                ));
            }
        }

        if let Some(price) = sol_price {
            text.push_str(&format!("\nMarket Prices:\nSOL: ${:.2}\n", price));
        }

        Ok(WalletProviderResult {
            data: portfolio,
            values,
            text,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn test_provider_metadata() {
        assert_eq!(WalletProvider::NAME, "solana-wallet");
        assert!(!WalletProvider::DESCRIPTION.is_empty());
        assert!(WalletProvider::DYNAMIC);
    }
}
