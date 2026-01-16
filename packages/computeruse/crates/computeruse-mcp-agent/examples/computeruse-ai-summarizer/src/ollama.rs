use anyhow::Result;
use ollama_rs::{generation::completion::request::GenerationRequest, Ollama};
use serde_json::Value;

pub async fn summrize_by_ollama(
    model: &str,
    system_prompt: &str,
    mcp_result: &Value,
) -> Result<String> {
    let ollama = Ollama::default();
    tracing::info!("sending context to ollama model: {}", model);

    let prompt = format!("{system_prompt}\n Screen ui element tree: {mcp_result}");

    let request = GenerationRequest::new(model.to_string(), prompt);
    let response = ollama.generate(request).await?;

    tracing::info!("successfully received response from Ollama");

    Ok(response.response)
}
