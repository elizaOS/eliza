//! Tokenization model handlers.

use crate::error::{ElizaCloudError, Result};
use crate::types::{DetokenizeTextParams, ElizaCloudConfig, TokenizeTextParams};

/// Get the actual model name based on model type.
fn get_model_name(config: &ElizaCloudConfig, model_type: &str) -> String {
    if model_type == "TEXT_SMALL" {
        config.small_model.clone()
    } else {
        config.large_model.clone()
    }
}

/// Handle TEXT_TOKENIZER_ENCODE - tokenize text into token IDs.
///
/// Uses tiktoken-rs for tokenization compatible with OpenAI models.
///
/// # Arguments
///
/// * `config` - ElizaOS Cloud configuration
/// * `params` - Tokenization parameters with prompt and model type
///
/// # Returns
///
/// List of token IDs.
pub async fn handle_tokenizer_encode(
    config: ElizaCloudConfig,
    params: TokenizeTextParams,
) -> Result<Vec<u32>> {
    let model_name = get_model_name(&config, &params.model_type);

    // Get the appropriate encoding based on model
    let bpe = tiktoken_rs::get_bpe_from_model(&model_name)
        .or_else(|_| tiktoken_rs::cl100k_base())
        .map_err(|e| ElizaCloudError::Configuration(format!("Failed to get tokenizer: {}", e)))?;

    let tokens = bpe.encode_ordinary(&params.prompt);
    // tiktoken-rs returns Vec<usize>, convert to Vec<u32>
    Ok(tokens.into_iter().map(|t| t as u32).collect())
}

/// Handle TEXT_TOKENIZER_DECODE - decode token IDs back to text.
///
/// Uses tiktoken-rs for detokenization compatible with OpenAI models.
///
/// # Arguments
///
/// * `config` - ElizaOS Cloud configuration
/// * `params` - Detokenization parameters with tokens and model type
///
/// # Returns
///
/// Decoded text string.
pub async fn handle_tokenizer_decode(
    config: ElizaCloudConfig,
    params: DetokenizeTextParams,
) -> Result<String> {
    let model_name = get_model_name(&config, &params.model_type);

    // Get the appropriate encoding based on model
    let bpe = tiktoken_rs::get_bpe_from_model(&model_name)
        .or_else(|_| tiktoken_rs::cl100k_base())
        .map_err(|e| ElizaCloudError::Configuration(format!("Failed to get tokenizer: {}", e)))?;

    // tiktoken-rs decode expects Vec<u32> (Rank type)
    let text = bpe
        .decode(params.tokens)
        .map_err(|e| ElizaCloudError::Configuration(format!("Failed to decode tokens: {}", e)))?;

    Ok(text)
}
