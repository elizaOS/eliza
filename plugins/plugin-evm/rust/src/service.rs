#![allow(missing_docs)]

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::constants::{CACHE_REFRESH_INTERVAL_SECS, EVM_SERVICE_NAME};
use crate::error::EVMResult;
use crate::providers::WalletProvider;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvmWalletChainData {
    pub chain_name: String,
    pub name: String,
    pub balance: String,
    pub symbol: String,
    pub chain_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvmWalletData {
    pub address: String,
    pub chains: Vec<EvmWalletChainData>,
    pub timestamp: u64,
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Lightweight service wrapper for EVM wallet data (TS parity: `EVMService`).
pub struct EVMService {
    wallet_provider: Arc<WalletProvider>,
    cached: Mutex<Option<EvmWalletData>>,
}

impl EVMService {
    pub const SERVICE_TYPE: &'static str = EVM_SERVICE_NAME;

    pub fn new(wallet_provider: Arc<WalletProvider>) -> Self {
        Self {
            wallet_provider,
            cached: Mutex::new(None),
        }
    }

    pub async fn refresh_wallet_data(&self) -> EVMResult<()> {
        let balances = self.wallet_provider.get_all_balances().await?;
        let address = format!("{:?}", self.wallet_provider.address());

        let mut chains: Vec<EvmWalletChainData> = Vec::new();
        for b in balances {
            let chain = b.chain;
            chains.push(EvmWalletChainData {
                chain_name: chain.to_string(),
                name: chain.to_string(),
                balance: b.native_balance,
                symbol: chain.native_symbol().to_string(),
                chain_id: chain.chain_id(),
            });
        }

        let data = EvmWalletData {
            address,
            chains,
            timestamp: now_ms(),
        };

        let mut guard = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(data);
        Ok(())
    }

    pub async fn get_cached_data(&self) -> EVMResult<Option<EvmWalletData>> {
        let cached = {
            let guard = self.cached.lock().unwrap_or_else(|e| e.into_inner());
            guard.clone()
        };

        let Some(data) = cached else {
            return Ok(None);
        };

        let max_age_ms = CACHE_REFRESH_INTERVAL_SECS.saturating_mul(1000);
        let age_ms = now_ms().saturating_sub(data.timestamp);
        if age_ms > max_age_ms {
            return Ok(None);
        }

        Ok(Some(data))
    }

    pub async fn force_update(&self) -> EVMResult<Option<EvmWalletData>> {
        self.refresh_wallet_data().await?;
        self.get_cached_data().await
    }

    pub fn wallet_provider(&self) -> Arc<WalletProvider> {
        self.wallet_provider.clone()
    }

    pub async fn stop(&self) -> EVMResult<()> {
        let mut guard = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
        Ok(())
    }
}
