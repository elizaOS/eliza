#![allow(missing_docs)]
//! Object/structured generation model handlers.

use crate::error::Result;
use crate::providers::ElizaCloudClient;
use crate::types::{ElizaCloudConfig, ObjectGenerationParams, TextGenerationParams};

/// Parse JSON from model response, handling markdown code blocks.
fn parse_json_response(content: &str) -> Result<serde_json::Value> {
    // Try to extract JSON from markdown code blocks
    let content = if let Some(start) = content.find("```") {
        let after_backticks = &content[start + 3..];
        // Skip optional language identifier (e.g., "json")
        let json_start = after_backticks.find('\n').map(|i| i + 1).unwrap_or(0);
        let after_lang = &after_backticks[json_start..];
        if let Some(end) = after_lang.find("```") {
            after_lang[..end].trim()
        } else {
            content.trim()
        }
    } else {
        content.trim()
    };

    // Try to parse as JSON
    match serde_json::from_str(content) {
        Ok(v) => Ok(v),
        Err(_) => {
            // Try to find JSON object in the content
            if let Some(start) = content.find('{') {
                if let Some(end) = content.rfind('}') {
                    let json_str = &content[start..=end];
                    serde_json::from_str(json_str).map_err(Into::into)
                } else {
                    serde_json::from_str(content).map_err(Into::into)
                }
            } else {
                serde_json::from_str(content).map_err(Into::into)
            }
        }
    }
}

/// Handle OBJECT_SMALL model generation.
///
/// Generates structured JSON objects using the small model.
///
/// # Arguments
///
/// * `config` - ElizaOS Cloud configuration
/// * `params` - Object generation parameters
///
/// # Returns
///
/// Generated object as JSON value.
pub async fn handle_object_small(
    config: ElizaCloudConfig,
    params: ObjectGenerationParams,
) -> Result<serde_json::Value> {
    let client = ElizaCloudClient::new(config)?;
    
    // Add JSON instruction to prompt
    let enhanced_prompt = format!("{}\n\nRespond with valid JSON only.", params.prompt);
    
    let text = client.generate_text_small(TextGenerationParams {
        prompt: enhanced_prompt,
        temperature: params.temperature,
        ..Default::default()
    }).await?;
    
    parse_json_response(&text)
}

/// Handle OBJECT_LARGE model generation.
///
/// Generates structured JSON objects using the large model.
///
/// # Arguments
///
/// * `config` - ElizaOS Cloud configuration
/// * `params` - Object generation parameters
///
/// # Returns
///
/// Generated object as JSON value.
pub async fn handle_object_large(
    config: ElizaCloudConfig,
    params: ObjectGenerationParams,
) -> Result<serde_json::Value> {
    let client = ElizaCloudClient::new(config)?;
    
    // Add JSON instruction to prompt
    let enhanced_prompt = format!("{}\n\nRespond with valid JSON only.", params.prompt);
    
    let text = client.generate_text_large(TextGenerationParams {
        prompt: enhanced_prompt,
        temperature: params.temperature,
        ..Default::default()
    }).await?;
    
    parse_json_response(&text)
}







