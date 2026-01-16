//! On-Chain LLM Client for llama_cpp_canister
//!
//! This module provides an interface to call llama_cpp_canister for fully
//! decentralized LLM inference on the Internet Computer.
//!
//! ## Architecture
//!
//! ```
//! ┌─────────────────┐     inter-canister     ┌─────────────────────┐
//! │ elizaOS Canister│─────────call──────────▶│ llama_cpp_canister  │
//! │                 │◀────────────────────────│ (Qwen/Llama model)  │
//! └─────────────────┘                         └─────────────────────┘
//! ```
//!
//! ## Usage
//!
//! The llama_cpp_canister API requires multiple update calls to:
//! 1. Start a new chat session
//! 2. Ingest the prompt (may need multiple calls)
//! 3. Generate tokens (may need multiple calls until EOG)

use crate::types::{CanisterError, CanisterResult, OnChainLLMConfig};
use candid::{CandidType, Decode, Encode, Principal};
use ic_cdk::api::call::call_raw;
use serde::{Deserialize, Serialize};

/// Arguments for new_chat call
#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct NewChatArgs {
    pub args: Vec<String>,
}

/// Arguments for run_update call
#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct RunUpdateArgs {
    pub args: Vec<String>,
}

/// Response from run_update call
#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct RunUpdateResponse {
    pub output: String,
    pub conversation: String,
    pub error: String,
    pub status_code: u16,
    pub prompt_remaining: String,
    pub generated_eog: bool,
}

/// Wrapper for Ok/Err variant responses from llama_cpp_canister
/// Note: llama_cpp_canister uses RunOutputRecord for BOTH Ok and Err
#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub enum OutputRecordResult {
    Ok(RunUpdateResponse),
    Err(RunUpdateResponse),
}

/// Status code record result
#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub enum StatusCodeRecordResult {
    Ok(StatusCodeRecord),
    Err(ApiError),
}

#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub struct StatusCodeRecord {
    pub status_code: u16,
}

#[derive(Debug, Clone, CandidType, Serialize, Deserialize)]
pub enum ApiError {
    Other(String),
    StatusCode(u16),
}

/// On-chain LLM client for inter-canister calls to llama_cpp_canister
pub struct OnChainLLMClient {
    config: OnChainLLMConfig,
}

impl OnChainLLMClient {
    /// Create a new client with the given configuration
    pub fn new(config: OnChainLLMConfig) -> Self {
        Self { config }
    }

    /// Check if the client is configured with a valid canister ID
    pub fn is_configured(&self) -> bool {
        self.config.is_configured()
    }

    /// Get the canister ID
    pub fn canister_id(&self) -> Principal {
        self.config.canister_id
    }

    /// Start a new chat session
    pub async fn new_chat(&self) -> CanisterResult<()> {
        if !self.is_configured() {
            return Err(CanisterError::InvalidInput(
                "On-chain LLM canister not configured".to_string(),
            ));
        }

        let args = NewChatArgs {
            args: vec![
                "--prompt-cache".to_string(),
                "prompt.cache".to_string(),
                "--cache-type-k".to_string(),
                self.config.cache_type_k.clone(),
            ],
        };

        let encoded = Encode!(&args).map_err(|e| {
            CanisterError::SerializationError(format!("Failed to encode new_chat args: {}", e))
        })?;

        let result = call_raw(self.config.canister_id, "new_chat", encoded, 0)
            .await
            .map_err(|(code, msg)| {
                CanisterError::InternalError(format!(
                    "new_chat call failed: code={:?}, msg={}",
                    code, msg
                ))
            })?;

        // Decode the result - llama_cpp_canister uses OutputRecordResult
        let decoded: OutputRecordResult = Decode!(&result, OutputRecordResult).map_err(|e| {
            CanisterError::SerializationError(format!("Failed to decode new_chat response: {}", e))
        })?;

        match decoded {
            OutputRecordResult::Ok(response) => {
                if response.status_code == 200 {
                    Ok(())
                } else {
                    Err(CanisterError::InternalError(format!(
                        "new_chat returned status {}: {}",
                        response.status_code, response.error
                    )))
                }
            }
            OutputRecordResult::Err(response) => Err(CanisterError::InternalError(format!(
                "new_chat error: {}",
                response.error
            ))),
        }
    }

    /// Run a single update call for prompt ingestion or token generation
    async fn run_update_once(
        &self,
        prompt: &str,
        max_tokens: u32,
    ) -> CanisterResult<RunUpdateResponse> {
        let args = RunUpdateArgs {
            args: vec![
                "--prompt-cache".to_string(),
                "prompt.cache".to_string(),
                "--prompt-cache-all".to_string(),
                "--cache-type-k".to_string(),
                self.config.cache_type_k.clone(),
                "--repeat-penalty".to_string(),
                "1.1".to_string(),
                "--temp".to_string(),
                format!("{}", self.config.temperature),
                "-sp".to_string(),
                "-p".to_string(),
                prompt.to_string(),
                "-n".to_string(),
                max_tokens.to_string(),
            ],
        };

        let encoded = Encode!(&args).map_err(|e| {
            CanisterError::SerializationError(format!("Failed to encode run_update args: {}", e))
        })?;

        let result = call_raw(self.config.canister_id, "run_update", encoded, 0)
            .await
            .map_err(|(code, msg)| {
                CanisterError::InternalError(format!(
                    "run_update call failed: code={:?}, msg={}",
                    code, msg
                ))
            })?;

        // Decode the result - llama_cpp_canister uses OutputRecordResult
        let decoded: OutputRecordResult = Decode!(&result, OutputRecordResult).map_err(|e| {
            CanisterError::SerializationError(format!(
                "Failed to decode run_update response: {}",
                e
            ))
        })?;

        match decoded {
            OutputRecordResult::Ok(response) => {
                if !response.error.is_empty() && response.status_code != 200 {
                    Err(CanisterError::InternalError(format!(
                        "LLM error: {}",
                        response.error
                    )))
                } else {
                    Ok(response)
                }
            }
            OutputRecordResult::Err(response) => Err(CanisterError::InternalError(format!(
                "run_update error: {}",
                response.error
            ))),
        }
    }

    /// Generate a chat completion
    ///
    /// This handles the full flow:
    /// 1. Start new chat
    /// 2. Ingest prompt (multiple calls if needed)
    /// 3. Generate tokens (multiple calls until EOG or max_tokens)
    pub async fn chat_completion(
        &self,
        system_prompt: &str,
        user_message: &str,
        conversation_history: &[(String, String)],
    ) -> CanisterResult<String> {
        if !self.is_configured() {
            return Err(CanisterError::InvalidInput(
                "On-chain LLM canister not configured".to_string(),
            ));
        }

        // Build the prompt in Qwen chat format
        let mut prompt = format!(
            "<|im_start|>system\n{}<|im_end|>\n",
            self.config
                .system_prompt
                .as_ref()
                .unwrap_or(&system_prompt.to_string())
        );

        // Add conversation history
        for (role, content) in conversation_history {
            let im_role = match role.as_str() {
                "assistant" => "assistant",
                _ => "user",
            };
            prompt.push_str(&format!(
                "<|im_start|>{}\n{}<|im_end|>\n",
                im_role, content
            ));
        }

        // Add current user message
        prompt.push_str(&format!(
            "<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n",
            user_message
        ));

        ic_cdk::println!("On-chain LLM: Starting chat completion");

        // Start new chat session
        self.new_chat().await?;

        // Phase 1: Ingest the prompt
        // Keep calling with -n 1 until prompt_remaining is empty
        let mut ingest_attempts = 0;
        const MAX_INGEST_ATTEMPTS: u32 = 50;

        loop {
            ingest_attempts += 1;
            if ingest_attempts > MAX_INGEST_ATTEMPTS {
                return Err(CanisterError::InternalError(
                    "Prompt ingestion exceeded max attempts".to_string(),
                ));
            }

            let response = self.run_update_once(&prompt, 1).await?;

            if response.prompt_remaining.is_empty() {
                ic_cdk::println!(
                    "On-chain LLM: Prompt ingested after {} calls",
                    ingest_attempts
                );
                break;
            }
        }

        // Phase 2: Generate tokens
        // Keep calling with empty prompt until generated_eog is true
        let mut full_output = String::new();
        let mut generate_attempts = 0;
        let max_generate_calls = (self.config.max_tokens / 10).max(20) as u32; // Rough estimate

        loop {
            generate_attempts += 1;
            if generate_attempts > max_generate_calls {
                ic_cdk::println!(
                    "On-chain LLM: Reached max generate calls ({})",
                    max_generate_calls
                );
                break;
            }

            let response = self.run_update_once("", self.config.max_tokens).await?;

            full_output.push_str(&response.output);

            if response.generated_eog {
                ic_cdk::println!(
                    "On-chain LLM: Generation complete after {} calls",
                    generate_attempts
                );
                break;
            }
        }

        // Clean up the output (remove chat markers if present)
        let cleaned = full_output
            .trim()
            .trim_end_matches("<|im_end|>")
            .trim()
            .to_string();

        Ok(cleaned)
    }

    /// Remove the prompt cache to free stable memory
    pub async fn cleanup(&self) -> CanisterResult<()> {
        if !self.is_configured() {
            return Ok(());
        }

        #[derive(CandidType, Serialize)]
        struct RemovePromptCacheArgs {
            args: Vec<String>,
        }

        let args = RemovePromptCacheArgs {
            args: vec!["--prompt-cache".to_string(), "prompt.cache".to_string()],
        };

        let encoded = Encode!(&args).map_err(|e| {
            CanisterError::SerializationError(format!("Failed to encode cleanup args: {}", e))
        })?;

        let _ = call_raw(self.config.canister_id, "remove_prompt_cache", encoded, 0)
            .await
            .map_err(|(code, msg)| {
                CanisterError::InternalError(format!(
                    "remove_prompt_cache call failed: code={:?}, msg={}",
                    code, msg
                ))
            })?;

        Ok(())
    }
}

/// Check if the llama_cpp_canister is ready for inference
pub async fn check_llm_canister_health(canister_id: Principal) -> CanisterResult<bool> {
    let encoded = Encode!(&()).map_err(|e| {
        CanisterError::SerializationError(format!("Failed to encode health args: {}", e))
    })?;

    let result = call_raw(canister_id, "health", encoded, 0)
        .await
        .map_err(|(code, msg)| {
            CanisterError::InternalError(format!(
                "health check failed: code={:?}, msg={}",
                code, msg
            ))
        })?;

    let decoded: StatusCodeRecordResult =
        Decode!(&result, StatusCodeRecordResult).map_err(|e| {
            CanisterError::SerializationError(format!("Failed to decode health response: {}", e))
        })?;

    match decoded {
        StatusCodeRecordResult::Ok(health) => Ok(health.status_code == 200),
        StatusCodeRecordResult::Err(_) => Ok(false),
    }
}

/// Check if the model is loaded and ready
pub async fn check_llm_ready(canister_id: Principal) -> CanisterResult<bool> {
    let encoded = Encode!(&()).map_err(|e| {
        CanisterError::SerializationError(format!("Failed to encode ready args: {}", e))
    })?;

    let result = call_raw(canister_id, "ready", encoded, 0)
        .await
        .map_err(|(code, msg)| {
            CanisterError::InternalError(format!("ready check failed: code={:?}, msg={}", code, msg))
        })?;

    let decoded: StatusCodeRecordResult = Decode!(&result, StatusCodeRecordResult).map_err(|e| {
        CanisterError::SerializationError(format!("Failed to decode ready response: {}", e))
    })?;

    match decoded {
        StatusCodeRecordResult::Ok(ready) => Ok(ready.status_code == 200),
        StatusCodeRecordResult::Err(_) => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_not_configured() {
        let config = OnChainLLMConfig::default();
        assert!(!config.is_configured());
    }

    #[test]
    fn test_config_configured() {
        let config = OnChainLLMConfig {
            canister_id: Principal::from_text("aaaaa-aa").unwrap(),
            ..Default::default()
        };
        assert!(config.is_configured());
    }
}
