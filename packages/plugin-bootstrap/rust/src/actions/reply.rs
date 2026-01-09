//! REPLY action implementation.

use async_trait::async_trait;
use std::sync::Arc;

use crate::error::{PluginError, PluginResult};
use crate::runtime::{IAgentRuntime, ModelParams};
use crate::types::{ActionResult, Memory, ModelType, State};
use crate::xml::parse_key_value_xml;

use super::Action;

const REPLY_TEMPLATE: &str = r#"# Task: Generate dialog for the character {{agentName}}.

{{providers}}

# Instructions: Write the next message for {{agentName}}.
"thought" should be a short description of what the agent is thinking about and planning.
"text" should be the next message for {{agentName}} which they will send to the conversation.

IMPORTANT CODE BLOCK FORMATTING RULES:
- If {{agentName}} includes code examples, snippets, or multi-line code in the response, ALWAYS wrap the code with ``` fenced code blocks (specify the language if known, e.g., ```python).
- ONLY use fenced code blocks for actual code. Do NOT wrap non-code text, instructions, or single words in fenced code blocks.
- If including inline code (short single words or function names), use single backticks (`) as appropriate.
- This ensures the user sees clearly formatted and copyable code when relevant.

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
    <thought>Your thought here</thought>
    <text>Your message here</text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>."#;

/// Action for generating and sending a reply message.
pub struct ReplyAction;

#[async_trait]
impl Action for ReplyAction {
    fn name(&self) -> &'static str {
        "REPLY"
    }

    fn similes(&self) -> &[&'static str] {
        &["GREET", "REPLY_TO_MESSAGE", "SEND_REPLY", "RESPOND", "RESPONSE"]
    }

    fn description(&self) -> &'static str {
        "Replies to the current conversation with the text from the generated message. \
         Default if the agent is responding with a message and no other action. \
         Use REPLY at the beginning of a chain of actions as an acknowledgement, \
         and at the end of a chain of actions as a final response."
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        state: Option<&State>,
        responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let state = state.ok_or_else(|| {
            PluginError::StateRequired("State is required for reply action".to_string())
        })?;

        // Gather providers from previous responses
        let mut all_providers: Vec<&str> = vec!["RECENT_MESSAGES", "ACTION_STATE"];
        if let Some(resps) = responses {
            for resp in resps {
                for provider in &resp.content.providers {
                    if !all_providers.contains(&provider.as_str()) {
                        all_providers.push(Box::leak(provider.clone().into_boxed_str()));
                    }
                }
            }
        }

        // Compose state with providers
        let composed_state = runtime.compose_state(message, &all_providers).await?;

        // Get template
        let template = runtime
            .character()
            .templates
            .get("replyTemplate")
            .map(|s| s.as_str())
            .unwrap_or(REPLY_TEMPLATE);

        let prompt = runtime.compose_prompt(&composed_state, template);

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
            .ok_or_else(|| PluginError::XmlParse("Failed to parse response XML".to_string()))?;

        let thought = parsed.get("thought").cloned().unwrap_or_default();
        let text = parsed.get("text").cloned().unwrap_or_default();

        Ok(ActionResult::success(format!("Generated reply: {}", text))
            .with_value("success", true)
            .with_value("responded", true)
            .with_value("lastReply", text.clone())
            .with_value("lastReplyTime", runtime.get_current_timestamp())
            .with_value("thoughtProcess", thought.clone())
            .with_data("actionName", "REPLY")
            .with_data("thought", thought)
            .with_data("messageGenerated", true)
            .with_data("text", text))
    }
}

