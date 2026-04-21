//! ACTIONS provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::deterministic::{build_deterministic_seed, deterministic_int};
use crate::error::PluginResult;
use crate::generated::action_docs::ALL_ACTION_DOCS_JSON;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::prompt_compression::{compress_prompt_description, is_prompt_compression_enabled};
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
    #[serde(default, rename = "descriptionCompressed")]
    description_compressed: Option<String>,
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
    #[serde(default, rename = "descriptionCompressed")]
    description_compressed: Option<String>,
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
        let schema_str = format_schema(&p.schema);
        let examples_str = if p.examples.is_empty() {
            None
        } else {
            Some(format!(
                "examples={}",
                p.examples
                    .iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<String>>()
                    .join("|")
            ))
        };
        let modifiers = examples_str.into_iter().collect::<Vec<String>>().join("; ");
        let suffix = if modifiers.is_empty() {
            String::new()
        } else {
            format!(" [{}]", modifiers)
        };
        lines.push(format!(
            "{}{}:{}{} - {}",
            p.name,
            if p.required { "" } else { "?" },
            schema_str,
            suffix,
            p.description
        ));
    }
    lines.join("; ")
}

fn format_action_parameters_compressed(params: &[ActionParameterDoc]) -> String {
    if params.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = Vec::new();
    for p in params {
        let desc = p
            .description_compressed
            .as_deref()
            .map(|s| s.to_string())
            .unwrap_or_else(|| compress_prompt_description(&p.description));
        let schema_str = format_schema(&p.schema);
        let examples_str = if p.examples.is_empty() {
            None
        } else {
            Some(format!(
                "examples={}",
                p.examples
                    .iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<String>>()
                    .join("|")
            ))
        };
        let modifiers = examples_str.into_iter().collect::<Vec<String>>().join("; ");
        let suffix = if modifiers.is_empty() {
            String::new()
        } else {
            format!(" [{}]", modifiers)
        };
        lines.push(format!(
            "{}{}:{}{} - {}",
            p.name,
            if p.required { "" } else { "?" },
            schema_str,
            suffix,
            desc
        ));
    }
    lines.join("; ")
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
        message: &Memory,
        state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let actions = runtime.get_available_actions();
        let docs_by_name = action_docs_by_name();

        if actions.is_empty() {
            return Ok(ProviderResult::new("No actions available."));
        }

        let state_room_id = state
            .and_then(|s| s.data.as_ref())
            .and_then(|d| d.room.as_ref())
            .map(|room| room.id.trim().to_string())
            .filter(|id| !id.is_empty());
        let state_world_id = state
            .and_then(|s| s.data.as_ref())
            .and_then(|d| d.world.as_ref())
            .map(|world| world.id.trim().to_string())
            .filter(|id| !id.is_empty());
        let room_id = state_room_id.unwrap_or_else(|| message.room_id.to_string());
        let world_id = state_world_id
            .or_else(|| message.world_id.as_ref().map(ToString::to_string))
            .unwrap_or_else(|| "world:none".to_string());
        let character_id = runtime
            .character()
            .id
            .clone()
            .map(|id| id.to_string())
            .unwrap_or_else(|| runtime.agent_id().to_string());
        let action_seed = build_deterministic_seed(&[
            "eliza-prompt-cache-v1".to_string(),
            world_id,
            room_id,
            character_id,
            "0".to_string(),
            "provider:actions".to_string(),
        ]);

        let shuffled_names =
            deterministic_shuffle(&actions, &format!("{}:names", action_seed), "actions");
        let names_text = shuffled_names
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<&str>>()
            .join(", ");

        let mut formatted_actions: Vec<String> = Vec::new();
        let mut actions_data: Vec<serde_json::Value> = Vec::new();
        let shuffled_descriptions = deterministic_shuffle(
            &actions,
            &format!("{}:descriptions", action_seed),
            "actions",
        );

        let use_compression = is_prompt_compression_enabled(runtime);

        for a in shuffled_descriptions.iter() {
            let doc = docs_by_name.get(&a.name);
            let prompt_desc = if use_compression {
                if let Some(d) = doc {
                    d.description_compressed
                        .clone()
                        .unwrap_or_else(|| compress_prompt_description(&d.description))
                } else {
                    compress_prompt_description(&a.description)
                }
            } else if let Some(d) = doc {
                d.description.clone()
            } else {
                a.description.clone()
            };
            let mut line = format!("- {}: {}", a.name, prompt_desc);
            if let Some(d) = doc {
                if !d.parameters.is_empty() {
                    let params_text = if use_compression {
                        format_action_parameters_compressed(&d.parameters)
                    } else {
                        format_action_parameters(&d.parameters)
                    };
                    if !params_text.is_empty() {
                        line.push_str(&format!("\n  params[{}]: ", d.parameters.len()));
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

        let text = format!(
            "Possible response actions: {}\n\n# Available Actions\nactions[{}]:\n{}",
            names_text,
            actions.len(),
            formatted_actions.join("\n")
        );

        Ok(ProviderResult::new(text)
            .with_value("actionNames", names_text)
            .with_value("actionCount", actions.len() as i64)
            .with_data(
                "actions",
                serde_json::to_value(&actions_data).unwrap_or_default(),
            ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_shuffle_is_stable() {
        let input = vec!["A".to_string(), "B".to_string(), "C".to_string()];
        let first = deterministic_shuffle(&input, "seed", "surface");
        let second = deterministic_shuffle(&input, "seed", "surface");
        assert_eq!(first, second);
        assert_eq!(first.len(), input.len());
    }

    #[test]
    fn format_action_parameters_is_compact() {
        let formatted = format_action_parameters(&[ActionParameterDoc {
            name: "direction".to_string(),
            description: "Direction to move.".to_string(),
            required: true,
            schema: serde_json::json!({
                "type": "string",
                "enum": ["north", "south"]
            }),
            examples: vec![serde_json::json!("north"), serde_json::json!("south")],
        }]);

        assert!(formatted.contains("direction:string"));
        assert!(formatted.contains("values: north, south"));
        assert!(formatted.contains("examples=\"north\"|\"south\""));
    }
}
