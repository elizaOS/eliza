//! Google GenAI model definitions.
//!
//! Provides strongly typed model constants and utilities.

use crate::error::{GoogleGenAIError, Result};

/// Model size category.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelSize {
    /// Small model (fast, efficient).
    Small,
    /// Large model (most capable).
    Large,
    /// Embedding model.
    Embedding,
}

/// Google Gemini model.
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
    /// Gemini 2.0 Flash - Fast and efficient.
    pub const GEMINI_2_0_FLASH: &'static str = "gemini-2.0-flash-001";
    /// Gemini 2.5 Pro - Most capable model.
    pub const GEMINI_2_5_PRO: &'static str = "gemini-2.5-pro-preview-03-25";
    /// Gemini 2.5 Pro Experimental.
    pub const GEMINI_2_5_PRO_EXP: &'static str = "gemini-2.5-pro-exp-03-25";
    /// Text Embedding 004.
    pub const TEXT_EMBEDDING_004: &'static str = "text-embedding-004";

    /// Create a new model from an ID string.
    ///
    /// # Errors
    ///
    /// Returns an error if the model ID is empty.
    pub fn new<S: Into<String>>(id: S) -> Result<Self> {
        let id = id.into();
        if id.is_empty() {
            return Err(GoogleGenAIError::invalid_parameter(
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

    /// Create the default small model (Gemini 2.0 Flash).
    pub fn small() -> Self {
        Self {
            id: Self::GEMINI_2_0_FLASH.to_string(),
            size: ModelSize::Small,
            default_max_tokens: 8192,
        }
    }

    /// Create the default large model (Gemini 2.5 Pro).
    pub fn large() -> Self {
        Self {
            id: Self::GEMINI_2_5_PRO.to_string(),
            size: ModelSize::Large,
            default_max_tokens: 8192,
        }
    }

    /// Create the default embedding model.
    pub fn embedding() -> Self {
        Self {
            id: Self::TEXT_EMBEDDING_004.to_string(),
            size: ModelSize::Embedding,
            default_max_tokens: 0,
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

    /// Check if this is an embedding model.
    pub fn is_embedding(&self) -> bool {
        self.size == ModelSize::Embedding
    }

    /// Infer model size from ID.
    fn infer_size(id: &str) -> ModelSize {
        let id_lower = id.to_lowercase();
        if id_lower.contains("embedding") {
            ModelSize::Embedding
        } else if id_lower.contains("flash") {
            ModelSize::Small
        } else {
            ModelSize::Large
        }
    }

    /// Infer default max tokens from ID.
    fn infer_max_tokens(id: &str) -> u32 {
        let id_lower = id.to_lowercase();
        if id_lower.contains("embedding") {
            0 // Embeddings don't have output tokens
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
        let flash = Model::new(Model::GEMINI_2_0_FLASH).unwrap();
        assert_eq!(flash.size(), ModelSize::Small);

        let pro = Model::new(Model::GEMINI_2_5_PRO).unwrap();
        assert_eq!(pro.size(), ModelSize::Large);

        let embedding = Model::new(Model::TEXT_EMBEDDING_004).unwrap();
        assert_eq!(embedding.size(), ModelSize::Embedding);
    }

    #[test]
    fn test_default_max_tokens() {
        let flash = Model::new(Model::GEMINI_2_0_FLASH).unwrap();
        assert_eq!(flash.default_max_tokens(), 8192);

        let embedding = Model::new(Model::TEXT_EMBEDDING_004).unwrap();
        assert_eq!(embedding.default_max_tokens(), 0);
    }

    #[test]
    fn test_empty_model_id() {
        let result = Model::new("");
        assert!(result.is_err());
    }
}

