//! Contacts provider implementation.

use async_trait::async_trait;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

/// Provider for contact information from the rolodex.
pub struct ContactsProvider;

#[async_trait]
impl Provider for ContactsProvider {
    fn name(&self) -> &'static str {
        "CONTACTS"
    }

    fn description(&self) -> &'static str {
        "Provides contact information from the rolodex"
    }

    fn is_dynamic(&self) -> bool {
        true
    }

    async fn get(
        &self,
        runtime: &dyn IAgentRuntime,
        _message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        // Check if rolodex service is available
        if runtime.get_service("rolodex").is_none() {
            return Ok(ProviderResult::empty());
        }

        // Return service availability indicator
        // Full integration with RolodexService would query contact details
        Ok(ProviderResult::with_text(
            "Contact information available via the rolodex service.".to_string(),
        )
        .with_value("contactsAvailable", true))
    }
}

