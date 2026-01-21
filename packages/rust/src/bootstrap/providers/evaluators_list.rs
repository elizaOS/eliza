//! EVALUATORS provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::error::PluginResult;
use crate::generated::action_docs::ALL_EVALUATOR_DOCS_JSON;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("EVALUATORS"));

#[derive(Debug, Clone, Deserialize)]
struct EvaluatorDocsRoot {
    evaluators: Vec<EvaluatorDoc>,
}

#[derive(Debug, Clone, Deserialize)]
struct EvaluatorDoc {
    name: String,
    description: String,
    #[serde(default)]
    similes: Vec<String>,
    #[serde(default)]
    examples: Vec<EvaluatorExampleDoc>,
}

#[derive(Debug, Clone, Deserialize)]
struct EvaluatorExampleDoc {
    prompt: String,
    messages: Vec<EvaluatorMessageDoc>,
    outcome: String,
}

#[derive(Debug, Clone, Deserialize)]
struct EvaluatorMessageDoc {
    name: String,
    content: HashMap<String, serde_json::Value>,
}

fn evaluator_docs_by_name() -> &'static HashMap<String, EvaluatorDoc> {
    static CACHE: OnceLock<HashMap<String, EvaluatorDoc>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let parsed: serde_json::Value =
            serde_json::from_str(ALL_EVALUATOR_DOCS_JSON).expect("invalid ALL_EVALUATOR_DOCS_JSON");
        let root: EvaluatorDocsRoot =
            serde_json::from_value(parsed).expect("invalid evaluator docs root");
        root.evaluators
            .into_iter()
            .map(|e| (e.name.clone(), e))
            .collect()
    })
}

fn format_evaluator_examples(e: &EvaluatorDoc, max_examples: usize) -> String {
    let mut blocks: Vec<String> = Vec::new();
    for ex in e.examples.iter().take(max_examples) {
        let mut b = format!("Prompt: {}\nOutcome: {}", ex.prompt, ex.outcome);
        if !ex.messages.is_empty() {
            b.push_str("\nMessages:");
            for m in &ex.messages {
                let text = m.content.get("text").and_then(|v| v.as_str()).unwrap_or("");
                b.push_str(&format!("\n- {}: {}", m.name, text));
            }
        }
        blocks.push(b);
    }
    blocks.join("\n\n")
}

/// Provider for available evaluators.
pub struct EvaluatorsProvider;

#[async_trait]
impl Provider for EvaluatorsProvider {
    fn name(&self) -> &'static str {
        "EVALUATORS"
    }

    fn description(&self) -> &'static str {
        "Available evaluators for assessing agent behavior"
    }

    fn is_dynamic(&self) -> bool {
        false
    }

    async fn get(
        &self,
        _runtime: &dyn IAgentRuntime,
        _message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        // Get evaluators from the bootstrap plugin itself
        let evaluators = crate::bootstrap::evaluators::all_evaluators();
        let docs_by_name = evaluator_docs_by_name();

        if evaluators.is_empty() {
            return Ok(
                ProviderResult::new("No evaluators available.").with_value("evaluatorCount", 0i64)
            );
        }

        let evaluator_info: Vec<serde_json::Value> = evaluators
            .iter()
            .map(|e| {
                let doc = docs_by_name.get(e.name());
                serde_json::json!({
                    "name": e.name(),
                    "description": e.description(),
                    "examples": doc.map(|d| &d.examples).unwrap_or(&Vec::new()),
                    "similes": doc.map(|d| &d.similes).unwrap_or(&Vec::new()),
                })
            })
            .collect();

        let formatted: Vec<String> = evaluators
            .iter()
            .map(|e| format!("- {}: {}", e.name(), e.description()))
            .collect();

        let mut text = format!("# Available Evaluators\n{}", formatted.join("\n"));
        // Include examples from canonical docs (if present).
        let mut example_blocks: Vec<String> = Vec::new();
        for e in evaluators.iter() {
            if let Some(doc) = docs_by_name.get(e.name()) {
                let ex_text = format_evaluator_examples(doc, 1);
                if !ex_text.is_empty() {
                    example_blocks.push(format!("## {}\n{}", doc.name, ex_text));
                }
            }
        }
        if !example_blocks.is_empty() {
            text.push_str("\n\n# Evaluator Examples\n");
            text.push_str(&example_blocks.join("\n\n"));
        }

        let names: Vec<&str> = evaluators.iter().map(|e| e.name()).collect();

        Ok(ProviderResult::new(text)
            .with_value("evaluatorCount", evaluators.len() as i64)
            .with_data(
                "evaluatorNames",
                serde_json::to_value(&names).unwrap_or_default(),
            )
            .with_data(
                "evaluators",
                serde_json::to_value(&evaluator_info).unwrap_or_default(),
            ))
    }
}
