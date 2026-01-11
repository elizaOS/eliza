#![allow(missing_docs)]
//! Configuration utilities for Vercel AI Gateway plugin.

use crate::error::{GatewayError, Result};
use crate::types::GatewayConfig;

/// Models that don't support temperature/sampling parameters (reasoning models).
const NO_TEMPERATURE_MODELS: &[&str] = &[
    "o1",
    "o1-preview",
    "o1-mini",
    "o3",
    "o3-mini",
    "gpt-5",
    "gpt-5-mini",
];

/// Check if a model supports temperature parameter.
pub fn model_supports_temperature(model: &str) -> bool {
    let model_lower = model.to_lowercase();
    !NO_TEMPERATURE_MODELS
        .iter()
        .any(|&m| model_lower.contains(m))
}

impl GatewayConfig {
    /// Create configuration from environment variables.
    ///
    /// # Environment Variables
    ///
    /// - `AI_GATEWAY_API_KEY` or `AIGATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`: API key (required)
    /// - `AI_GATEWAY_BASE_URL`: Base URL
    /// - `AI_GATEWAY_SMALL_MODEL`: Small model
    /// - `AI_GATEWAY_LARGE_MODEL`: Large model
    /// - `AI_GATEWAY_EMBEDDING_MODEL`: Embedding model
    /// - `AI_GATEWAY_EMBEDDING_DIMENSIONS`: Embedding dimensions
    ///
    /// # Errors
    ///
    /// Returns an error if no API key is found.
    pub fn from_env() -> Result<Self> {
        let api_key = std::env::var("AI_GATEWAY_API_KEY")
            .or_else(|_| std::env::var("AIGATEWAY_API_KEY"))
            .or_else(|_| std::env::var("VERCEL_OIDC_TOKEN"))
            .map_err(|_| {
                GatewayError::ConfigError(
                    "AI_GATEWAY_API_KEY, AIGATEWAY_API_KEY, or VERCEL_OIDC_TOKEN is required"
                        .to_string(),
                )
            })?;

        let mut config = Self::new(&api_key);

        if let Ok(base_url) = std::env::var("AI_GATEWAY_BASE_URL") {
            config = config.base_url(&base_url);
        }

        if let Ok(small_model) = std::env::var("AI_GATEWAY_SMALL_MODEL") {
            config = config.small_model(&small_model);
        }

        if let Ok(large_model) = std::env::var("AI_GATEWAY_LARGE_MODEL") {
            config = config.large_model(&large_model);
        }

        if let Ok(embedding_model) = std::env::var("AI_GATEWAY_EMBEDDING_MODEL") {
            config = config.embedding_model(&embedding_model);
        }

        if let Ok(dims) = std::env::var("AI_GATEWAY_EMBEDDING_DIMENSIONS") {
            if let Ok(dims) = dims.parse::<usize>() {
                config = config.embedding_dimensions(dims);
            }
        }

        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_model_supports_temperature() {
        assert!(!model_supports_temperature("gpt-5"));
        assert!(!model_supports_temperature("gpt-5-mini"));
        assert!(!model_supports_temperature("o1-preview"));
        assert!(model_supports_temperature("gpt-4o"));
        assert!(model_supports_temperature("claude-3-sonnet"));
    }
}







