//! ACTIONS provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::error::PluginResult;
use crate::generated::action_docs::ALL_ACTION_DOCS_JSON;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("ACTIONS"));

#[derive(Debug, Clone, Deserialize)]
struct ActionDocsRoot {
    actions: Vec<ActionDoc>,
}

#[derive(Debug, Clone, Deserialize)]
struct ActionDoc {
    name: String,
    description: String,
    #[serde(default)]
    similes: Vec<String>,
    #[serde(default)]
    parameters: Vec<ActionParameterDoc>,
    #[serde(default)]
    #[serde(rename = "exampleCalls")]
    example_calls: Vec<ActionExampleCallDoc>,
}

#[derive(Debug, Clone, Deserialize)]
struct ActionParameterDoc {
    name: String,
    description: String,
    #[serde(default)]
    required: bool,
    schema: serde_json::Value,
    #[serde(default)]
    examples: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct ActionExampleCallDoc {
    user: String,
    actions: Vec<String>,
    #[serde(default)]
    params: HashMap<String, HashMap<String, serde_json::Value>>,
}

fn action_docs_by_name() -> &'static HashMap<String, ActionDoc> {
    static CACHE: OnceLock<HashMap<String, ActionDoc>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let parsed: serde_json::Value =
            serde_json::from_str(ALL_ACTION_DOCS_JSON).expect("invalid ALL_ACTION_DOCS_JSON");
        let root: ActionDocsRoot =
            serde_json::from_value(parsed).expect("invalid action docs root");
        root.actions
            .into_iter()
            .map(|a| (a.name.clone(), a))
            .collect()
    })
}

fn format_schema(schema: &serde_json::Value) -> String {
    let t = schema
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let mut out = t.to_string();
    if t == "number" {
        let min = schema.get("minimum").and_then(|v| v.as_f64());
        let max = schema.get("maximum").and_then(|v| v.as_f64());
        if min.is_some() || max.is_some() {
            out = format!(
                "number [{}-{}]",
                min.map(|v| v.to_string())
                    .unwrap_or_else(|| "∞".to_string()),
                max.map(|v| v.to_string())
                    .unwrap_or_else(|| "∞".to_string())
            );
        }
    }
    if let Some(en) = schema.get("enum").and_then(|v| v.as_array()) {
        let vals: Vec<String> = en
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect();
        if !vals.is_empty() {
            out.push_str(&format!(" [values: {}]", vals.join(", ")));
        }
    }
    if let Some(def) = schema.get("default") {
        out.push_str(&format!(" [default: {}]", def));
    }
    out
}

fn format_action_parameters(params: &[ActionParameterDoc]) -> String {
    if params.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = Vec::new();
    for p in params {
        let required_str = if p.required {
            " (required)"
        } else {
            " (optional)"
        };
        let schema_str = format_schema(&p.schema);
        let examples_str = if p.examples.is_empty() {
            String::new()
        } else {
            format!(
                " [examples: {}]",
                p.examples
                    .iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<String>>()
                    .join(", ")
            )
        };
        lines.push(format!(
            "    - {}{}: {} ({}{})",
            p.name, required_str, p.description, schema_str, examples_str
        ));
    }
    lines.join("\n")
}

fn format_action_examples(docs: &[ActionDoc], max_examples: usize) -> String {
    if max_examples == 0 {
        return String::new();
    }
    let mut blocks: Vec<String> = Vec::new();
    for action in docs.iter() {
        for ex in action.example_calls.iter() {
            if blocks.len() >= max_examples {
                break;
            }
            let actions_xml = ex
                .actions
                .iter()
                .map(|a| format!("  <action>{}</action>", a))
                .collect::<Vec<String>>()
                .join("\n");

            let mut params_blocks: Vec<String> = Vec::new();
            for (action_name, params) in ex.params.iter() {
                let mut inner: Vec<String> = Vec::new();
                for (k, v) in params.iter() {
                    let raw = if v.is_string() {
                        v.as_str().unwrap_or_default().to_string()
                    } else {
                        v.to_string()
                    };
                    inner.push(format!("    <{}>{}</{}>", k, raw, k));
                }
                params_blocks.push(format!(
                    "  <{}>\n{}\n  </{}>",
                    action_name,
                    inner.join("\n"),
                    action_name
                ));
            }

            let params_xml = if params_blocks.is_empty() {
                String::new()
            } else {
                format!("\n<params>\n{}\n</params>", params_blocks.join("\n"))
            };

            let b = format!(
                "User: {}\nAssistant:\n<actions>\n{}\n</actions>{}",
                ex.user, actions_xml, params_xml
            );
            blocks.push(b);
        }
        if blocks.len() >= max_examples {
            break;
        }
    }
    blocks.join("\n\n")
}

/// Provider for available actions.
pub struct ActionsProvider;

#[async_trait]
impl Provider for ActionsProvider {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    fn is_dynamic(&self) -> bool {
        SPEC.dynamic.unwrap_or(false)
    }

    async fn get(
        &self,
        runtime: &dyn IAgentRuntime,
        _message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let actions = runtime.get_available_actions();
        let docs_by_name = action_docs_by_name();

        if actions.is_empty() {
            return Ok(ProviderResult::new("No actions available."));
        }

        let action_names: Vec<&str> = actions.iter().map(|a| a.name.as_str()).collect();
        let names_text = action_names.join(", ");

        let mut formatted_actions: Vec<String> = Vec::new();
        let mut actions_data: Vec<serde_json::Value> = Vec::new();

        for a in actions.iter() {
            let doc = docs_by_name.get(&a.name);
            let mut line = if let Some(d) = doc {
                format!("- **{}**: {}", a.name, d.description)
            } else {
                format!("- **{}**: {}", a.name, a.description)
            };
            if let Some(d) = doc {
                if !d.parameters.is_empty() {
                    let params_text = format_action_parameters(&d.parameters);
                    if !params_text.is_empty() {
                        line.push_str("\n  Parameters:\n");
                        line.push_str(&params_text);
                    }
                }
                actions_data.push(serde_json::json!({
                    "name": a.name,
                    "description": d.description,
                    "parameters": d.parameters,
                    "similes": d.similes,
                }));
            } else {
                actions_data.push(serde_json::json!({
                    "name": a.name,
                    "description": a.description,
                    "parameters": [],
                }));
            }
            formatted_actions.push(line);
        }

        // Optional parameter examples section sourced from canonical docs.
        let docs_for_examples: Vec<ActionDoc> = actions
            .iter()
            .filter_map(|a| docs_by_name.get(&a.name).cloned())
            .collect();
        let examples_text = format_action_examples(&docs_for_examples, 10);

        let mut text = format!(
            "Possible response actions: {}\n\n# Available Actions\n{}",
            names_text,
            formatted_actions.join("\n")
        );
        if !examples_text.is_empty() {
            text.push_str("\n\n# Action Examples\n");
            text.push_str(&examples_text);
        }

        Ok(ProviderResult::new(text)
            .with_value("actionNames", names_text)
            .with_value("actionCount", actions.len() as i64)
            .with_data(
                "actions",
                serde_json::to_value(&actions_data).unwrap_or_default(),
            ))
    }
}
