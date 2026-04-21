//! Secrets actions — SET_SECRET, GET_SECRET, DELETE_SECRET.

use async_trait::async_trait;
use std::sync::Arc;

use crate::basic_capabilities::actions::Action;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::service::SecretsService;
use super::types::*;

// ============================================================================
// SET_SECRET
// ============================================================================

/// Action to set a secret value.
pub struct SetSecretAction {
    service: Arc<SecretsService>,
}

impl SetSecretAction {
    /// Create a new SetSecretAction.
    pub fn new(service: Arc<SecretsService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Action for SetSecretAction {
    fn name(&self) -> &'static str {
        "SET_SECRET"
    }

    fn similes(&self) -> &[&'static str] {
        &["STORE_SECRET", "SAVE_SECRET", "SET_API_KEY"]
    }

    fn description(&self) -> &'static str {
        "Store a secret value securely"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        _message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let params = state
            .and_then(|s| s.get_value("actionParams"))
            .cloned()
            .unwrap_or_default();

        let key = params
            .get("key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                crate::error::PluginError::InvalidInput("Missing 'key' parameter".to_string())
            })?;

        let value = params
            .get("value")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                crate::error::PluginError::InvalidInput("Missing 'value' parameter".to_string())
            })?;

        let level = params
            .get("level")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str::<SecretLevel>(&format!("\"{}\"", s)).ok())
            .unwrap_or(SecretLevel::Global);

        let context = SecretContext {
            level,
            world_id: params.get("worldId").and_then(|v| v.as_str()).map(String::from),
            user_id: params.get("userId").and_then(|v| v.as_str()).map(String::from),
            agent_id: runtime.agent_id().to_string(),
            requester_id: None,
        };

        match self.service.set(key, value, &context, None).await {
            Ok(_) => Ok(ActionResult::success(format!("Secret '{}' stored successfully", key))
                .with_data("key", key.to_string())
                .with_data("actionName", "SET_SECRET")),
            Err(e) => Ok(ActionResult::error(format!("Failed to store secret: {}", e))),
        }
    }
}

// ============================================================================
// GET_SECRET
// ============================================================================

/// Action to retrieve a secret value.
pub struct GetSecretAction {
    service: Arc<SecretsService>,
}

impl GetSecretAction {
    /// Create a new GetSecretAction.
    pub fn new(service: Arc<SecretsService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Action for GetSecretAction {
    fn name(&self) -> &'static str {
        "GET_SECRET"
    }

    fn similes(&self) -> &[&'static str] {
        &["READ_SECRET", "FETCH_SECRET", "GET_API_KEY"]
    }

    fn description(&self) -> &'static str {
        "Retrieve a stored secret value"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        _message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let params = state
            .and_then(|s| s.get_value("actionParams"))
            .cloned()
            .unwrap_or_default();

        let key = params
            .get("key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                crate::error::PluginError::InvalidInput("Missing 'key' parameter".to_string())
            })?;

        let level = params
            .get("level")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str::<SecretLevel>(&format!("\"{}\"", s)).ok())
            .unwrap_or(SecretLevel::Global);

        let context = SecretContext {
            level,
            world_id: params.get("worldId").and_then(|v| v.as_str()).map(String::from),
            user_id: params.get("userId").and_then(|v| v.as_str()).map(String::from),
            agent_id: runtime.agent_id().to_string(),
            requester_id: None,
        };

        match self.service.get(key, &context).await {
            Ok(Some(value)) => {
                // Never expose secret values in text output
                Ok(ActionResult::success(format!("Secret '{}' retrieved", key))
                    .with_value("secretValue", value)
                    .with_data("key", key.to_string())
                    .with_data("found", serde_json::json!(true))
                    .with_data("actionName", "GET_SECRET"))
            }
            Ok(None) => Ok(ActionResult::success(format!("Secret '{}' not found", key))
                .with_data("key", key.to_string())
                .with_data("found", serde_json::json!(false))
                .with_data("actionName", "GET_SECRET")),
            Err(e) => Ok(ActionResult::error(format!("Failed to retrieve secret: {}", e))),
        }
    }
}

// ============================================================================
// DELETE_SECRET
// ============================================================================

/// Action to delete a stored secret.
pub struct DeleteSecretAction {
    service: Arc<SecretsService>,
}

impl DeleteSecretAction {
    /// Create a new DeleteSecretAction.
    pub fn new(service: Arc<SecretsService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Action for DeleteSecretAction {
    fn name(&self) -> &'static str {
        "DELETE_SECRET"
    }

    fn similes(&self) -> &[&'static str] {
        &["REMOVE_SECRET", "REVOKE_SECRET"]
    }

    fn description(&self) -> &'static str {
        "Delete a stored secret"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        _message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let params = state
            .and_then(|s| s.get_value("actionParams"))
            .cloned()
            .unwrap_or_default();

        let key = params
            .get("key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                crate::error::PluginError::InvalidInput("Missing 'key' parameter".to_string())
            })?;

        let level = params
            .get("level")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str::<SecretLevel>(&format!("\"{}\"", s)).ok())
            .unwrap_or(SecretLevel::Global);

        let context = SecretContext {
            level,
            world_id: params.get("worldId").and_then(|v| v.as_str()).map(String::from),
            user_id: params.get("userId").and_then(|v| v.as_str()).map(String::from),
            agent_id: runtime.agent_id().to_string(),
            requester_id: None,
        };

        match self.service.delete(key, &context).await {
            Ok(true) => Ok(ActionResult::success(format!("Secret '{}' deleted", key))
                .with_data("actionName", "DELETE_SECRET")),
            Ok(false) => Ok(ActionResult::success(format!("Secret '{}' not found", key))
                .with_data("actionName", "DELETE_SECRET")),
            Err(e) => Ok(ActionResult::error(format!("Failed to delete secret: {}", e))),
        }
    }
}
