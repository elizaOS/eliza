#![allow(missing_docs)]

use rust_decimal::Decimal;
use std::collections::HashMap;
use tracing::{error, info};

use crate::client::SolanaClient;
use crate::types::{PortfolioItem, WalletPortfolio};
use crate::WRAPPED_SOL_MINT;

#[derive(Debug, Clone)]
pub struct WalletProviderResult {
    pub data: WalletPortfolio,
    pub values: HashMap<String, String>,
    pub text: String,
}

pub struct WalletProvider;

impl WalletProvider {
    pub const NAME: &'static str = "solana-wallet";
    pub const DESCRIPTION: &'static str = "your solana wallet information";
    pub const DYNAMIC: bool = true;

    pub async fn get(
        client: &SolanaClient,
        agent_name: Option<&str>,
    ) -> Result<WalletProviderResult, String> {
        let agent_name = agent_name.unwrap_or("The agent");
        let pubkey = client.public_key();
        let pubkey_str = pubkey.to_string();

        info!("Fetching wallet portfolio for {}", pubkey_str);

        let sol_balance = match client.get_sol_balance().await {
            Ok(b) => b,
            Err(e) => {
                error!("Failed to get SOL balance: {}", e);
                return Err(format!("Failed to get SOL balance: {}", e));
            }
        };

        let token_accounts = match client.get_token_accounts().await {
            Ok(ta) => ta,
            Err(e) => {
                error!("Failed to get token accounts: {}", e);
                vec![]
            }
        };

        let sol_price = match client
            .get_token_prices(&[WRAPPED_SOL_MINT.to_string()])
            .await
        {
            Ok(prices) => prices.get(WRAPPED_SOL_MINT).copied(),
            Err(_) => None,
        };

        let sol_value_usd = if let Some(price) = sol_price {
            sol_balance * Decimal::from_f64_retain(price).unwrap_or(Decimal::ZERO)
        } else {
            Decimal::ZERO
        };

        let mut items: Vec<PortfolioItem> = vec![];

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

        for account in token_accounts {
            if account.ui_amount > Decimal::ZERO {
                items.push(PortfolioItem {
                    name: account.mint.clone(),
                    symbol: "TOKEN".to_string(),
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

        let total_usd = sol_value_usd;

        let portfolio = WalletPortfolio {
            total_usd: total_usd.to_string(),
            total_sol: Some(sol_balance.to_string()),
            items: items.clone(),
            prices: None,
            last_updated: Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            ),
        };

        let mut values: HashMap<String, String> = HashMap::new();
        values.insert("total_usd".to_string(), total_usd.to_string());
        values.insert("total_sol".to_string(), sol_balance.to_string());

        if let Some(price) = sol_price {
            values.insert("sol_price".to_string(), price.to_string());
        }

        for (idx, item) in items.iter().enumerate() {
            values.insert(format!("token_{}_name", idx), item.name.clone());
            values.insert(format!("token_{}_symbol", idx), item.symbol.clone());
            values.insert(format!("token_{}_amount", idx), item.ui_amount.clone());
            values.insert(format!("token_{}_usd", idx), item.value_usd.clone());
            if let Some(ref sol_val) = item.value_sol {
                values.insert(format!("token_{}_sol", idx), sol_val.clone());
            }
        }

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
