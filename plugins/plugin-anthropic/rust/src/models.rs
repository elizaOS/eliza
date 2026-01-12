use crate::error::{AnthropicError, Result};

/// Categorization of model sizes for cost/performance tradeoffs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelSize {
    /// Small, fast, and cost-effective models (e.g., Haiku).
    Small,
    /// Large, powerful models with better reasoning (e.g., Sonnet, Opus).
    Large,
}

/// Represents an Anthropic Claude model.
///
/// Contains the model identifier, size category, and default token limits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Model {
    id: String,
    size: ModelSize,
    default_max_tokens: u32,
}

impl Model {
    /// Model ID for Claude 3.5 Haiku.
    pub const CLAUDE_3_5_HAIKU: &'static str = "claude-3-5-haiku-20241022";
    /// Model ID for Claude 3 Haiku.
    pub const CLAUDE_3_HAIKU: &'static str = "claude-3-haiku-20240307";
    /// Model ID for Claude Sonnet 4.
    pub const CLAUDE_SONNET_4: &'static str = "claude-sonnet-4-20250514";
    /// Model ID for Claude 3.5 Sonnet.
    pub const CLAUDE_3_5_SONNET: &'static str = "claude-3-5-sonnet-20241022";
    /// Model ID for Claude 3 Opus.
    pub const CLAUDE_3_OPUS: &'static str = "claude-3-opus-20240229";

    /// Creates a new Model with the given identifier.
    ///
    /// Automatically infers the model size and default max tokens based on the ID.
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

    /// Returns the default small model (Claude 3.5 Haiku).
    pub fn small() -> Self {
        Self {
            id: Self::CLAUDE_3_5_HAIKU.to_string(),
            size: ModelSize::Small,
            default_max_tokens: 8192,
        }
    }

    /// Returns the default large model (Claude Sonnet 4).
    pub fn large() -> Self {
        Self {
            id: Self::CLAUDE_SONNET_4.to_string(),
            size: ModelSize::Large,
            default_max_tokens: 8192,
        }
    }

    /// Returns the model identifier string.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Returns the model's size category.
    pub fn size(&self) -> ModelSize {
        self.size
    }

    /// Returns the default maximum tokens for this model.
    pub fn default_max_tokens(&self) -> u32 {
        self.default_max_tokens
    }

    /// Returns true if this is a small model.
    pub fn is_small(&self) -> bool {
        self.size == ModelSize::Small
    }

    /// Returns true if this is a large model.
    pub fn is_large(&self) -> bool {
        self.size == ModelSize::Large
    }

    fn infer_size(id: &str) -> ModelSize {
        let id_lower = id.to_lowercase();
        if id_lower.contains("haiku") {
            ModelSize::Small
        } else {
            ModelSize::Large
        }
    }

    fn infer_max_tokens(id: &str) -> u32 {
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
