#![allow(missing_docs)]

use crate::client::ClobClient;
use crate::constants::{DEFAULT_CLOB_API_URL, POLYMARKET_SERVICE_NAME};
use crate::error::{PolymarketError, PolymarketErrorCode, Result};
use crate::types::ApiKeyCreds;

/// Minimal service wrapper for Polymarket (TS parity: `PolymarketService`).
pub struct PolymarketService {
    clob_client: ClobClient,
    authenticated_client: Option<ClobClient>,
}

impl PolymarketService {
    pub const SERVICE_TYPE: &'static str = POLYMARKET_SERVICE_NAME;

    pub async fn start(private_key: &str) -> Result<Self> {
        let clob_client = ClobClient::new(Some(DEFAULT_CLOB_API_URL), private_key).await?;
        Ok(Self {
            clob_client,
            authenticated_client: None,
        })
    }

    pub async fn start_with_creds(private_key: &str, creds: ApiKeyCreds) -> Result<Self> {
        let clob_client = ClobClient::new(Some(DEFAULT_CLOB_API_URL), private_key).await?;
        let authenticated_client =
            Some(ClobClient::new_with_creds(Some(DEFAULT_CLOB_API_URL), private_key, creds).await?);

        Ok(Self {
            clob_client,
            authenticated_client,
        })
    }

    #[must_use]
    pub fn client(&self) -> &ClobClient {
        &self.clob_client
    }

    pub fn authenticated_client(&self) -> Result<&ClobClient> {
        self.authenticated_client.as_ref().ok_or_else(|| {
            PolymarketError::new(
                PolymarketErrorCode::AuthError,
                "No API credentials configured",
            )
        })
    }

    pub async fn stop(&mut self) -> Result<()> {
        self.authenticated_client = None;
        Ok(())
    }
}
