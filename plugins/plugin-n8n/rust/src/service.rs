#![allow(missing_docs)]

use crate::client::PluginCreationClient;
use crate::error::Result;

pub const PLUGIN_CREATION_SERVICE_TYPE: &str = "plugin_creation";

/// Minimal service wrapper for plugin creation (TS parity: `PluginCreationService`).
pub struct PluginCreationService {
    client: PluginCreationClient,
}

impl PluginCreationService {
    pub const SERVICE_TYPE: &'static str = PLUGIN_CREATION_SERVICE_TYPE;
    pub const CAPABILITY_DESCRIPTION: &'static str = "Plugin creation service";

    pub fn new(client: PluginCreationClient) -> Self {
        Self { client }
    }

    pub fn from_env() -> Result<Self> {
        let client = crate::create_client_from_env()?;
        Ok(Self::new(client))
    }

    #[must_use]
    pub fn client(&self) -> &PluginCreationClient {
        &self.client
    }

    pub async fn stop(&mut self) -> Result<()> {
        Ok(())
    }
}
