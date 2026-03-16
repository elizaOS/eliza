use async_trait::async_trait;
use serde_json::{json, Value};

use crate::parsers::{format_directive_state, parse_all_directives};
use crate::types::{DirectiveState, ElevatedLevel};
use crate::{Provider, ProviderResult};

/// Provider that exposes current directive state to the agent.
///
/// On each call it parses the message text for inline directives, builds a
/// [`DirectiveState`] from the parsed values, and returns it as structured
/// JSON alongside a human-readable summary.
pub struct DirectiveStateProvider;

#[async_trait]
impl Provider for DirectiveStateProvider {
    fn name(&self) -> &str {
        "DIRECTIVE_STATE"
    }

    fn description(&self) -> &str {
        "Current directive levels (thinking, verbose, model, etc.)"
    }

    fn position(&self) -> i32 {
        10
    }

    async fn get(&self, message: &Value, _state: &Value) -> ProviderResult {
        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let directives = parse_all_directives(text);

        let state = DirectiveState {
            thinking: directives.think.unwrap_or_default(),
            verbose: directives.verbose.unwrap_or_default(),
            reasoning: directives.reasoning.unwrap_or_default(),
            elevated: directives.elevated.unwrap_or_default(),
            exec: directives
                .exec
                .clone()
                .unwrap_or_default(),
            model: directives
                .model
                .clone()
                .unwrap_or_default(),
        };

        let display = format_directive_state(&state);

        ProviderResult {
            values: json!({
                "thinkingLevel": state.thinking.to_string(),
                "verboseLevel": state.verbose.to_string(),
                "reasoningLevel": state.reasoning.to_string(),
                "elevatedLevel": state.elevated.to_string(),
                "isElevated": state.elevated != ElevatedLevel::Off,
                "modelProvider": state.model.provider.as_deref().unwrap_or(""),
                "modelName": state.model.model.as_deref().unwrap_or(""),
            }),
            text: display,
            data: json!({ "directives": state }),
        }
    }
}
