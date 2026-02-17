//! RLM (Recursive Language Model) plugin for elizaOS.
//!
//! This crate provides integration with Recursive Language Models (RLMs),
//! enabling LLMs to process arbitrarily long contexts through recursive
//! self-calls in a REPL environment.
//!
//! Reference:
//! - Paper: <https://arxiv.org/abs/2512.24601>
//! - Implementation: <https://github.com/alexzhang13/rlm>

#![warn(missing_docs)]

/// RLM client implementation.
pub mod client;
/// Error types.
pub mod error;
/// Type definitions.
pub mod types;

pub use client::{MessageInput, RLMClient};
pub use error::{RLMError, Result};
pub use types::{
    env_vars, RLMBackend, RLMConfig, RLMCost, RLMEnvironment, RLMInferOptions, RLMMessage,
    RLMMetadata, RLMResult, RLMStatusResponse, RLMStrategy, RLMTrajectory, RLMTrajectoryStep,
};

use anyhow::Result as AnyhowResult;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// High-level RLM plugin wrapper.
pub struct RLMPlugin {
    client: Arc<Mutex<RLMClient>>,
}

impl RLMPlugin {
    /// Create a new RLM plugin with the given configuration.
    pub fn new(config: RLMConfig) -> Result<Self> {
        let client = RLMClient::new(config)?;
        Ok(Self {
            client: Arc::new(Mutex::new(client)),
        })
    }

    /// Create a new RLM plugin with configuration from environment.
    pub fn from_env() -> Result<Self> {
        Self::new(RLMConfig::from_env())
    }

    /// Perform text generation.
    pub async fn generate_text(&self, prompt: &str) -> String {
        let client = self.client.lock().await;
        let result = client.infer(prompt.into(), None).await;
        result.text
    }

    /// Perform text generation with messages.
    pub async fn generate_text_with_messages(&self, messages: Vec<RLMMessage>) -> String {
        let client = self.client.lock().await;
        let result = client.infer(messages.into(), None).await;
        result.text
    }

    /// Get server status.
    pub async fn get_status(&self) -> RLMStatusResponse {
        let client = self.client.lock().await;
        client.get_status().await
    }

    /// Shutdown the plugin.
    pub async fn shutdown(&self) -> Result<()> {
        let client = self.client.lock().await;
        client.shutdown().await
    }
}

/// Get an RLM plugin instance from environment configuration.
pub fn get_rlm_plugin() -> AnyhowResult<RLMPlugin> {
    RLMPlugin::from_env().map_err(|e| anyhow::anyhow!("Failed to create RLM plugin: {}", e))
}

/// Create an elizaOS plugin definition for RLM.
pub fn create_rlm_elizaos_plugin() -> AnyhowResult<elizaos::types::Plugin> {
    use elizaos::types::{Plugin, PluginDefinition};

    let rlm = Arc::new(
        get_rlm_plugin().map_err(|e| anyhow::anyhow!("Failed to create RLM plugin: {}", e))?,
    );

    let mut model_handlers: HashMap<String, elizaos::types::ModelHandlerFn> = HashMap::new();

    // TEXT_LARGE handler
    let rlm_large = rlm.clone();
    model_handlers.insert(
        "TEXT_LARGE".to_string(),
        Box::new(move |params: serde_json::Value| {
            let rlm = rlm_large.clone();
            Box::pin(async move {
                let prompt = params.get("prompt").and_then(|v| v.as_str()).unwrap_or("");

                // Check for messages parameter
                if let Some(messages) = params.get("messages").and_then(|v| v.as_array()) {
                    let msgs: Vec<RLMMessage> = messages
                        .iter()
                        .filter_map(|m| {
                            let role = m.get("role")?.as_str()?.to_string();
                            let content = m.get("content")?.as_str()?.to_string();
                            Some(RLMMessage { role, content })
                        })
                        .collect();

                    if !msgs.is_empty() {
                        return Ok(rlm.generate_text_with_messages(msgs).await);
                    }
                }

                Ok(rlm.generate_text(prompt).await)
            })
        }),
    );

    // TEXT_SMALL handler (same as large for RLM)
    let rlm_small = rlm.clone();
    model_handlers.insert(
        "TEXT_SMALL".to_string(),
        Box::new(move |params: serde_json::Value| {
            let rlm = rlm_small.clone();
            Box::pin(async move {
                let prompt = params.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                Ok(rlm.generate_text(prompt).await)
            })
        }),
    );

    // TEXT_REASONING_LARGE handler
    let rlm_reasoning_large = rlm.clone();
    model_handlers.insert(
        "TEXT_REASONING_LARGE".to_string(),
        Box::new(move |params: serde_json::Value| {
            let rlm = rlm_reasoning_large.clone();
            Box::pin(async move {
                let prompt = params.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                Ok(rlm.generate_text(prompt).await)
            })
        }),
    );

    // TEXT_REASONING_SMALL handler
    let rlm_reasoning_small = rlm.clone();
    model_handlers.insert(
        "TEXT_REASONING_SMALL".to_string(),
        Box::new(move |params: serde_json::Value| {
            let rlm = rlm_reasoning_small.clone();
            Box::pin(async move {
                let prompt = params.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                Ok(rlm.generate_text(prompt).await)
            })
        }),
    );

    // TEXT_COMPLETION handler
    let rlm_completion = rlm.clone();
    model_handlers.insert(
        "TEXT_COMPLETION".to_string(),
        Box::new(move |params: serde_json::Value| {
            let rlm = rlm_completion.clone();
            Box::pin(async move {
                let prompt = params.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                Ok(rlm.generate_text(prompt).await)
            })
        }),
    );

    // TEXT_RLM_LARGE handler (explicit RLM)
    let rlm_explicit = rlm.clone();
    model_handlers.insert(
        "TEXT_RLM_LARGE".to_string(),
        Box::new(move |params: serde_json::Value| {
            let rlm = rlm_explicit.clone();
            Box::pin(async move {
                let prompt = params.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                Ok(rlm.generate_text(prompt).await)
            })
        }),
    );

    // TEXT_RLM_REASONING handler (explicit RLM with reasoning)
    let rlm_explicit_reasoning = rlm.clone();
    model_handlers.insert(
        "TEXT_RLM_REASONING".to_string(),
        Box::new(move |params: serde_json::Value| {
            let rlm = rlm_explicit_reasoning.clone();
            Box::pin(async move {
                let prompt = params.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                Ok(rlm.generate_text(prompt).await)
            })
        }),
    );

    Ok(Plugin {
        definition: PluginDefinition {
            name: "rlm".to_string(),
            description: "RLM (Recursive Language Model) adapter for elizaOS - enables processing of arbitrarily long contexts through recursive self-calls".to_string(),
            ..Default::default()
        },
        model_handlers,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_default() {
        let config = RLMConfig::default();
        assert_eq!(config.backend, RLMBackend::Gemini);
        assert_eq!(config.environment, RLMEnvironment::Local);
        assert_eq!(config.max_iterations, 4);
        assert_eq!(config.max_depth, 1);
        assert!(!config.verbose);
        // New fields
        assert!(config.track_costs);
        assert!(config.log_trajectories);
        assert_eq!(config.max_retries, 3);
    }

    #[test]
    fn test_config_validate() {
        let config = RLMConfig::default();
        assert!(config.validate().is_ok());

        let mut invalid = RLMConfig::default();
        invalid.max_iterations = 0;
        assert!(invalid.validate().is_err());

        // Test retry config validation
        let mut invalid_retry = RLMConfig::default();
        invalid_retry.retry_base_delay = 10.0;
        invalid_retry.retry_max_delay = 5.0;
        assert!(invalid_retry.validate().is_err());
    }

    #[test]
    fn test_rlm_message() {
        let msg = RLMMessage::user("Hello");
        assert_eq!(msg.role, "user");
        assert_eq!(msg.content, "Hello");

        let msg = RLMMessage::assistant("Hi there");
        assert_eq!(msg.role, "assistant");
    }

    #[test]
    fn test_stub_result() {
        let result = RLMResult::stub(Some("Test error".to_string()));
        assert!(result.metadata.stub);
        assert_eq!(result.metadata.error, Some("Test error".to_string()));
        assert!(result.cost.is_none());
        assert!(result.trajectory.is_none());
    }

    #[test]
    fn test_infer_options_defaults() {
        let opts = RLMInferOptions::default();
        assert!(opts.max_iterations.is_none());
        assert!(opts.max_depth.is_none());
        assert!(opts.root_model.is_none());
        assert!(opts.subcall_model.is_none());
        assert!(opts.log_trajectories.is_none());
        assert!(opts.track_costs.is_none());
    }

    #[test]
    fn test_rlm_cost() {
        let cost = RLMCost {
            root_input_tokens: 100,
            root_output_tokens: 50,
            subcall_input_tokens: 200,
            subcall_output_tokens: 100,
            root_cost_usd: 0.01,
            subcall_cost_usd: 0.02,
        };
        assert_eq!(cost.total_input_tokens(), 300);
        assert_eq!(cost.total_output_tokens(), 150);
        assert_eq!(cost.total_tokens(), 450);
        assert!((cost.total_cost_usd() - 0.03).abs() < 0.001);
    }
}
