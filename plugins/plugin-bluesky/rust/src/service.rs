#![allow(missing_docs)]

use crate::client::BlueSkyClient;
use crate::error::Result;

/// Minimal service wrapper for BlueSky (TS parity: `BlueSkyService`).
pub struct BlueSkyService {
    client: BlueSkyClient,
}

impl BlueSkyService {
    pub const SERVICE_TYPE: &'static str = "bluesky";
    pub const CAPABILITY_DESCRIPTION: &'static str = "Send and receive messages on BlueSky";

    pub fn new(client: BlueSkyClient) -> Self {
        Self { client }
    }

    pub fn from_env() -> Result<Self> {
        let client = crate::create_client_from_env()?;
        Ok(Self::new(client))
    }

    #[must_use]
    pub fn client(&self) -> &BlueSkyClient {
        &self.client
    }
}
