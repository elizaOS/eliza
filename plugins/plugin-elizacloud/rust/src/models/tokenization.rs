#![allow(missing_docs)]

use crate::error::{ElizaCloudError, Result};
use crate::types::{DetokenizeTextParams, ElizaCloudConfig, TokenizeTextParams};

fn get_model_name(config: &ElizaCloudConfig, model_type: &str) -> String {
    if model_type == "TEXT_SMALL" {
        config.small_model.clone()
    } else {
        config.large_model.clone()
    }
}

pub async fn handle_tokenizer_encode(
    config: ElizaCloudConfig,
    params: TokenizeTextParams,
) -> Result<Vec<u32>> {
    let model_name = get_model_name(&config, &params.model_type);

    let bpe = tiktoken_rs::get_bpe_from_model(&model_name)
        .or_else(|_| tiktoken_rs::cl100k_base())
        .map_err(|e| ElizaCloudError::Configuration(format!("Failed to get tokenizer: {}", e)))?;

    let tokens = bpe.encode_ordinary(&params.prompt);
    Ok(tokens.into_iter().collect())
}

pub async fn handle_tokenizer_decode(
    config: ElizaCloudConfig,
    params: DetokenizeTextParams,
) -> Result<String> {
    let model_name = get_model_name(&config, &params.model_type);

    let bpe = tiktoken_rs::get_bpe_from_model(&model_name)
        .or_else(|_| tiktoken_rs::cl100k_base())
        .map_err(|e| ElizaCloudError::Configuration(format!("Failed to get tokenizer: {}", e)))?;

    let text = bpe
        .decode(params.tokens)
        .map_err(|e| ElizaCloudError::Configuration(format!("Failed to decode tokens: {}", e)))?;

    Ok(text)
}
