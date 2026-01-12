#![allow(missing_docs)]

use crate::error::{GoogleGenAIError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelSize {
    Small,
    Large,
    Embedding,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Model {
    id: String,
    size: ModelSize,
    default_max_tokens: u32,
}

impl Model {
    pub const GEMINI_2_0_FLASH: &'static str = "gemini-2.0-flash-001";
    pub const GEMINI_2_5_PRO: &'static str = "gemini-2.5-pro-preview-03-25";
    pub const GEMINI_2_5_PRO_EXP: &'static str = "gemini-2.5-pro-exp-03-25";
    pub const TEXT_EMBEDDING_004: &'static str = "text-embedding-004";

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

    pub fn small() -> Self {
        Self {
            id: Self::GEMINI_2_0_FLASH.to_string(),
            size: ModelSize::Small,
            default_max_tokens: 8192,
        }
    }

    pub fn large() -> Self {
        Self {
            id: Self::GEMINI_2_5_PRO.to_string(),
            size: ModelSize::Large,
            default_max_tokens: 8192,
        }
    }

    pub fn embedding() -> Self {
        Self {
            id: Self::TEXT_EMBEDDING_004.to_string(),
            size: ModelSize::Embedding,
            default_max_tokens: 0,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn size(&self) -> ModelSize {
        self.size
    }

    pub fn default_max_tokens(&self) -> u32 {
        self.default_max_tokens
    }

    pub fn is_small(&self) -> bool {
        self.size == ModelSize::Small
    }

    pub fn is_large(&self) -> bool {
        self.size == ModelSize::Large
    }

    pub fn is_embedding(&self) -> bool {
        self.size == ModelSize::Embedding
    }

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

    fn infer_max_tokens(id: &str) -> u32 {
        let id_lower = id.to_lowercase();
        if id_lower.contains("embedding") {
            0
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
