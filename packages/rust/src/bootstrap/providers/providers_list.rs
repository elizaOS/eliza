//! PROVIDERS provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("PROVIDERS"));

/// Provider for listing available providers.
pub struct ProvidersListProvider;

#[async_trait]
impl Provider for ProvidersListProvider {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    fn is_dynamic(&self) -> bool {
        SPEC.dynamic.unwrap_or(false)
    }

    async fn get(
        &self,
        _runtime: &dyn IAgentRuntime,
        _message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        // Get providers from the bootstrap plugin itself
        let providers = super::all_providers();

        if providers.is_empty() {
            return Ok(
                ProviderResult::new("No providers available.").with_value("providerCount", 0i64)
            );
        }

        let provider_info: Vec<serde_json::Value> = providers
            .iter()
            .map(|p| {
                serde_json::json!({
                    "name": p.name(),
                    "description": p.description(),
                    "dynamic": p.is_dynamic()
                })
            })
            .collect();

        let formatted: Vec<String> = providers
            .iter()
            .map(|p| format!("- {}: {}", p.name(), p.description()))
            .collect();

        let text = format!("# Available Providers\n{}", formatted.join("\n"));

        let names: Vec<&str> = providers.iter().map(|p| p.name()).collect();

        Ok(ProviderResult::new(text)
            .with_value("providerCount", providers.len() as i64)
            .with_data(
                "providerNames",
                serde_json::to_value(&names).unwrap_or_default(),
            )
            .with_data(
                "providers",
                serde_json::to_value(&provider_info).unwrap_or_default(),
            ))
    }
}
