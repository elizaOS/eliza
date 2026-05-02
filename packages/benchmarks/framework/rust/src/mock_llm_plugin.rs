//! Mock LLM Plugin for Framework Benchmarking — Rust Runtime
//!
//! Replaces all LLM model handlers with deterministic, zero-latency handlers
//! that return pre-computed valid XML responses. This isolates framework
//! overhead from LLM latency for accurate performance measurement.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use elizaos::types::plugin::{ModelHandlerFn, Plugin, PluginDefinition};

// ─── Mock response constants ────────────────────────────────────────────────

const SHOULD_RESPOND_XML: &str = r#"<response>
  <name>BenchmarkAgent</name>
  <reasoning>The message is directed at me. I should respond.</reasoning>
  <action>RESPOND</action>
</response>"#;

const MESSAGE_HANDLER_XML: &str = r#"<response>
    <thought>Processing benchmark message. Will reply with a fixed response.</thought>
    <actions>REPLY</actions>
    <providers></providers>
    <text>This is a fixed benchmark response from the mock LLM plugin.</text>
    <simple>true</simple>
</response>"#;

const REPLY_ACTION_XML: &str = r#"<response>
    <thought>Generating a reply for the benchmark.</thought>
    <text>Fixed reply from mock LLM plugin.</text>
</response>"#;

const MULTI_STEP_DECISION_XML: &str = r#"<response>
  <thought>The task is straightforward, completing immediately.</thought>
  <action></action>
  <providers></providers>
  <isFinish>true</isFinish>
</response>"#;

const MULTI_STEP_SUMMARY_XML: &str = r#"<response>
  <thought>Summarizing benchmark run.</thought>
  <text>Benchmark multi-step task completed successfully.</text>
</response>"#;

const REFLECTION_XML: &str = r#"<response>
  <thought>Benchmark interaction processed normally.</thought>
  <facts></facts>
  <relationships></relationships>
</response>"#;

// ─── Handler implementations ────────────────────────────────────────────────

/// Detect which template is being used from the prompt and return appropriate response.
fn detect_and_respond_text_large(params: &serde_json::Value) -> String {
    let prompt = params
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if prompt.contains("Multi-Step Workflow") || prompt.contains("isFinish") {
        return MULTI_STEP_DECISION_XML.to_string();
    }
    if prompt.contains("Execution Trace") || prompt.contains("Summarize what the assistant") {
        return MULTI_STEP_SUMMARY_XML.to_string();
    }
    if prompt.contains("Generate Agent Reflection") || prompt.contains("Extract Facts") {
        return REFLECTION_XML.to_string();
    }
    if prompt.contains("Generate dialog for the character") && !prompt.contains("decide what actions") {
        return REPLY_ACTION_XML.to_string();
    }

    MESSAGE_HANDLER_XML.to_string()
}

fn detect_and_respond_text_small(params: &serde_json::Value) -> String {
    let prompt = params
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if prompt.contains("should respond") || prompt.contains("RESPOND | IGNORE | STOP") {
        return SHOULD_RESPOND_XML.to_string();
    }
    if prompt.contains("Respond with only a YES or a NO") {
        return "YES".to_string();
    }
    if prompt.contains("Generate dialog") {
        return MESSAGE_HANDLER_XML.to_string();
    }

    SHOULD_RESPOND_XML.to_string()
}

// ─── Plugin creation ────────────────────────────────────────────────────────

/// Create the mock LLM benchmark plugin with all model handlers registered.
pub fn create_mock_llm_plugin() -> Plugin {
    let mut model_handlers: HashMap<String, ModelHandlerFn> = HashMap::new();

    // TEXT_SMALL handler
    model_handlers.insert(
        "TEXT_SMALL".to_string(),
        Box::new(|params: serde_json::Value| -> Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send>> {
            Box::pin(async move {
                Ok(detect_and_respond_text_small(&params))
            })
        }),
    );

    // TEXT_LARGE handler
    model_handlers.insert(
        "TEXT_LARGE".to_string(),
        Box::new(|params: serde_json::Value| -> Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send>> {
            Box::pin(async move {
                Ok(detect_and_respond_text_large(&params))
            })
        }),
    );

    // TEXT_EMBEDDING handler (returns JSON array of 384 zeros)
    model_handlers.insert(
        "TEXT_EMBEDDING".to_string(),
        Box::new(|_params: serde_json::Value| -> Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send>> {
            Box::pin(async move {
                let zeros: Vec<f64> = vec![0.0; 384];
                Ok(serde_json::to_string(&zeros).unwrap_or_default())
            })
        }),
    );

    // TEXT_COMPLETION handler
    model_handlers.insert(
        "TEXT_COMPLETION".to_string(),
        Box::new(|params: serde_json::Value| -> Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send>> {
            Box::pin(async move {
                Ok(detect_and_respond_text_large(&params))
            })
        }),
    );

    // OBJECT_SMALL handler
    model_handlers.insert(
        "OBJECT_SMALL".to_string(),
        Box::new(|_params: serde_json::Value| -> Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send>> {
            Box::pin(async move {
                Ok(r#"{"result":"benchmark_object"}"#.to_string())
            })
        }),
    );

    // OBJECT_LARGE handler
    model_handlers.insert(
        "OBJECT_LARGE".to_string(),
        Box::new(|_params: serde_json::Value| -> Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send>> {
            Box::pin(async move {
                Ok(r#"{"result":"benchmark_object"}"#.to_string())
            })
        }),
    );

    Plugin {
        definition: PluginDefinition {
            name: "mock-llm-benchmark".to_string(),
            description: "Deterministic zero-latency mock LLM handlers for framework benchmarking".to_string(),
            ..Default::default()
        },
        model_handlers,
        ..Default::default()
    }
}
