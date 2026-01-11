//! Anthropic model definitions.
//!
//! Provides strongly typed model constants and utilities.

use crate::error::{AnthropicError, Result};

/// Model size category.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelSize {
    /// Small model (fast, efficient).
    Small,
    /// Large model (most capable).
    Large,
}

/// Anthropic Claude model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Model {
    /// The model identifier string.
    id: String,
    /// Model size category.
    size: ModelSize,
    /// Default max tokens for this model.
    default_max_tokens: u32,
}

impl Model {
    // Well-known model IDs
    /// Claude 3.5 Haiku - Fast and efficient.
    pub const CLAUDE_3_5_HAIKU: &'static str = "claude-3-5-haiku-20241022";
    /// Claude 3 Haiku - Previous generation fast model.
    pub const CLAUDE_3_HAIKU: &'static str = "claude-3-haiku-20240307";
    /// Claude Sonnet 4 - Most capable model.
    pub const CLAUDE_SONNET_4: &'static str = "claude-sonnet-4-20250514";
    /// Claude 3.5 Sonnet - Balanced performance.
    pub const CLAUDE_3_5_SONNET: &'static str = "claude-3-5-sonnet-20241022";
    /// Claude 3 Opus - Previous generation flagship.
    pub const CLAUDE_3_OPUS: &'static str = "claude-3-opus-20240229";

    /// Create a new model from an ID string.
    ///
    /// # Errors
    ///
    /// Returns an error if the model ID is empty.
    pub fn new<S: Into<String>>(id: S) -> Result<Self> {
        let id = id.into();
        if id.is_empty() {
            return Err(AnthropicError::invalid_parameter(
                "model",
                "Model ID cannot be empty",
            ));
        }

        let size = Self::infer_size(&id);
        let default_max_tokens = Self::infer_max_tokens(&id);

        Ok(Self {
            id,
            size,
            default_max_tokens,
        })
    }

    /// Create the default small model.
    pub fn small() -> Self {
        Self {
            id: Self::CLAUDE_3_5_HAIKU.to_string(),
            size: ModelSize::Small,
            default_max_tokens: 8192,
        }
    }

    /// Create the default large model.
    pub fn large() -> Self {
        Self {
            id: Self::CLAUDE_SONNET_4.to_string(),
            size: ModelSize::Large,
            default_max_tokens: 8192,
        }
    }

    /// Get the model ID.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Get the model size.
    pub fn size(&self) -> ModelSize {
        self.size
    }

    /// Get the default max tokens for this model.
    pub fn default_max_tokens(&self) -> u32 {
        self.default_max_tokens
    }

    /// Check if this is a small model.
    pub fn is_small(&self) -> bool {
        self.size == ModelSize::Small
    }

    /// Check if this is a large model.
    pub fn is_large(&self) -> bool {
        self.size == ModelSize::Large
    }

    /// Infer model size from ID.
    fn infer_size(id: &str) -> ModelSize {
        let id_lower = id.to_lowercase();
        if id_lower.contains("haiku") {
            ModelSize::Small
        } else {
            ModelSize::Large
        }
    }

    /// Infer default max tokens from ID.
    fn infer_max_tokens(id: &str) -> u32 {
        // Claude 3 models have 4096 default, newer models have 8192
        if id.contains("-3-") && !id.contains("-3-5-") {
            4096
        } else {
            8192
        }
    }
}

impl std::fmt::Display for Model {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.id)
    }
}

#[allow(clippy::derivable_impls)]
impl Default for Model {
    fn default() -> Self {
        Self::large()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_model_sizes() {
        let haiku = Model::new(Model::CLAUDE_3_5_HAIKU).unwrap();
        assert_eq!(haiku.size(), ModelSize::Small);

        let sonnet = Model::new(Model::CLAUDE_SONNET_4).unwrap();
        assert_eq!(sonnet.size(), ModelSize::Large);

        let opus = Model::new(Model::CLAUDE_3_OPUS).unwrap();
        assert_eq!(opus.size(), ModelSize::Large);
    }

    #[test]
    fn test_default_max_tokens() {
        let claude3_haiku = Model::new(Model::CLAUDE_3_HAIKU).unwrap();
        assert_eq!(claude3_haiku.default_max_tokens(), 4096);

        let claude35_haiku = Model::new(Model::CLAUDE_3_5_HAIKU).unwrap();
        assert_eq!(claude35_haiku.default_max_tokens(), 8192);
    }

    #[test]
    fn test_empty_model_id() {
        let result = Model::new("");
        assert!(result.is_err());
    }
}


