//! GOAL evaluator implementation.

use async_trait::async_trait;

use crate::error::{PluginError, PluginResult};
use crate::runtime::{IAgentRuntime, ModelParams};
use crate::types::{EvaluatorResult, Memory, ModelType, State};
use crate::xml::parse_key_value_xml;

use super::Evaluator;

const GOAL_EVALUATION_TEMPLATE: &str = r#"# Task: Evaluate progress toward goals.

{{providers}}

# Current Goals:
{{goals}}

# Recent Actions:
{{recentActions}}

# Instructions:
Evaluate how well the recent actions are contributing to the defined goals.
Rate progress on a scale of 0-100 and provide specific feedback.

Respond using XML format like this:
<response>
    <thought>Your analysis of goal progress</thought>
    <progress>Numeric progress score 0-100</progress>
    <feedback>Specific feedback on what's working and what isn't</feedback>
    <next_steps>Suggested next steps to make progress</next_steps>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Evaluator for goal progress.
pub struct GoalEvaluator;

#[async_trait]
impl Evaluator for GoalEvaluator {
    fn name(&self) -> &'static str {
        "GOAL"
    }

    fn description(&self) -> &'static str {
        "Evaluates progress toward defined goals and objectives"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn evaluate(
        &self,
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        state: Option<&State>,
    ) -> PluginResult<EvaluatorResult> {
        let state = match state {
            Some(s) => s,
            None => {
                return Ok(EvaluatorResult::fail(0, "No state provided for evaluation"));
            }
        };

        // Get goals from state
        let goals: Vec<String> = state
            .values
            .get("goals")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        if goals.is_empty() {
            return Ok(EvaluatorResult::pass(100, "No goals defined")
                .with_detail("noGoals", true));
        }

        // Get recent actions from state
        let recent_actions: Vec<String> = state
            .values
            .get("recentActions")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        // Format for prompt
        let goals_text = goals
            .iter()
            .map(|g| format!("- {}", g))
            .collect::<Vec<_>>()
            .join("\n");

        let actions_text = if recent_actions.is_empty() {
            "No recent actions".to_string()
        } else {
            recent_actions
                .iter()
                .map(|a| format!("- {}", a))
                .collect::<Vec<_>>()
                .join("\n")
        };

        // Get template and compose prompt
        let template = runtime
            .character()
            .templates
            .get("goalEvaluationTemplate")
            .map(|s| s.as_str())
            .unwrap_or(GOAL_EVALUATION_TEMPLATE);

        let composed_state = runtime
            .compose_state(message, &["RECENT_MESSAGES"])
            .await?;

        let prompt = runtime
            .compose_prompt(&composed_state, template)
            .replace("{{goals}}", &goals_text)
            .replace("{{recentActions}}", &actions_text);

        // Call the model
        let response = runtime
            .use_model(ModelType::TextLarge, ModelParams::with_prompt(&prompt))
            .await
            .map_err(|e| PluginError::ModelError(e.to_string()))?;

        let response_text = response
            .as_text()
            .ok_or_else(|| PluginError::ModelError("Expected text response".to_string()))?;

        // Parse XML response
        let parsed = parse_key_value_xml(response_text)
            .ok_or_else(|| PluginError::XmlParse("Failed to parse evaluation response".to_string()))?;

        let thought = parsed.get("thought").cloned().unwrap_or_default();
        let progress_str = parsed.get("progress").cloned().unwrap_or_else(|| "0".to_string());
        let feedback = parsed.get("feedback").cloned().unwrap_or_default();
        let next_steps = parsed.get("next_steps").cloned().unwrap_or_default();

        let progress: u8 = progress_str
            .parse()
            .unwrap_or(0)
            .min(100);

        let passed = progress >= 50;

        let result = if passed {
            EvaluatorResult::pass(progress, &feedback)
        } else {
            EvaluatorResult::fail(progress, &feedback)
        };

        Ok(result
            .with_detail("thought", thought)
            .with_detail("feedback", feedback)
            .with_detail("nextSteps", next_steps)
            .with_detail("goalCount", goals.len() as i64)
            .with_detail("actionCount", recent_actions.len() as i64))
    }
}

