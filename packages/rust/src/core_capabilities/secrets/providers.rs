//! Secrets provider — surfaces secret availability status in agent context.

use async_trait::async_trait;
use std::sync::Arc;

use crate::basic_capabilities::providers::Provider;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::service::SecretsService;
use super::types::*;

/// Provider that surfaces secret status (not values!) in agent context.
pub struct SecretsStatusProvider {
    service: Arc<SecretsService>,
}

impl SecretsStatusProvider {
    /// Create a new SecretsStatusProvider.
    pub fn new(service: Arc<SecretsService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Provider for SecretsStatusProvider {
    fn name(&self) -> &'static str {
        "SECRETS_STATUS"
    }

    fn description(&self) -> &'static str {
        "Status of configured secrets (availability, not values)"
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
        let context = SecretContext {
            level: SecretLevel::Global,
            world_id: None,
            user_id: None,
            agent_id: runtime.agent_id().to_string(),
            requester_id: None,
        };

        let secrets = self.service.list(&context).await;

        if secrets.is_empty() {
            return Ok(ProviderResult::new("No secrets configured.")
                .with_value("secretCount", 0i64));
        }

        let mut valid_count = 0;
        let mut missing_count = 0;
        let mut invalid_count = 0;

        let mut lines = Vec::new();
        for (key, config) in &secrets {
            let status_str = match config.status {
                SecretStatus::Valid => {
                    valid_count += 1;
                    "valid"
                }
                SecretStatus::Missing => {
                    missing_count += 1;
                    "MISSING"
                }
                SecretStatus::Invalid => {
                    invalid_count += 1;
                    "INVALID"
                }
                SecretStatus::Expired => {
                    invalid_count += 1;
                    "EXPIRED"
                }
                _ => "pending",
            };

            let required_marker = if config.required { " (required)" } else { "" };
            lines.push(format!(
                "  - {} [{}]: {:?}{}",
                key, status_str, config.secret_type, required_marker
            ));
        }

        let text = format!(
            "# Secrets Status\n\
             Valid: {} | Missing: {} | Invalid: {}\n\n\
             {}\n",
            valid_count,
            missing_count,
            invalid_count,
            lines.join("\n")
        );

        Ok(ProviderResult::new(text)
            .with_value("secretCount", secrets.len() as i64)
            .with_value("validSecrets", valid_count)
            .with_value("missingSecrets", missing_count))
    }
}
