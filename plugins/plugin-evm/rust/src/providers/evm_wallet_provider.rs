#![allow(missing_docs)]

use serde::Serialize;
use serde_json::{json, Value};

use super::ProviderResult;
use crate::error::EVMResult;
use crate::types::SupportedChain;
use crate::WalletProvider;

#[derive(Debug, Clone, Serialize)]
pub struct EvmWalletChainData {
    pub chain_name: String,
    pub name: String,
    pub balance: String,
    pub symbol: String,
    pub chain_id: u64,
}

/// Provider that summarizes wallet address + native balances (TS parity: `EVMWalletProvider`).
pub struct EVMWalletProvider;

impl EVMWalletProvider {
    pub const NAME: &'static str = "EVMWalletProvider";
    pub const DESCRIPTION: &'static str = "Provides EVM wallet address and chain balances";

    pub async fn get(&self, wallet_provider: &WalletProvider) -> EVMResult<ProviderResult> {
        let balances = wallet_provider.get_all_balances().await?;
        let address = format!("{:?}", wallet_provider.address());

        let mut chains: Vec<EvmWalletChainData> = Vec::new();
        for b in balances {
            let chain: SupportedChain = b.chain;
            chains.push(EvmWalletChainData {
                chain_name: chain.to_string(),
                name: chain.to_string(),
                balance: b.native_balance,
                symbol: chain.native_symbol().to_string(),
                chain_id: chain.chain_id(),
            });
        }

        let balance_text = chains
            .iter()
            .map(|c| format!("{}: {} {}", c.name, c.balance, c.symbol))
            .collect::<Vec<String>>()
            .join("\n");

        Ok(ProviderResult {
            text: format!(
                "EVM Wallet Address: {}\n\nBalances:\n{}",
                address, balance_text
            ),
            data: json!({ "address": address, "chains": chains }),
            values: Value::Object(serde_json::Map::new()),
        })
    }
}
