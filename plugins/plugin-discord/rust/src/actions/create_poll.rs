//! Create poll action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::Result;
use crate::types::Snowflake;
use crate::DiscordService;

/// Emoji sets for polls
const NUMBER_EMOJIS: [&str; 10] = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const LETTER_EMOJIS: [&str; 10] = ["🇦", "🇧", "🇨", "🇩", "🇪", "🇫", "🇬", "🇭", "🇮", "🇯"];
const YES_NO_EMOJIS: [&str; 2] = ["✅", "❌"];

/// Action to create a poll in Discord with emoji reactions for voting
pub struct CreatePollAction;

#[async_trait]
impl DiscordAction for CreatePollAction {
    fn name(&self) -> &str {
        "CREATE_POLL"
    }

    fn description(&self) -> &str {
        "Create a poll in Discord with emoji reactions for voting."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "MAKE_POLL",
            "START_POLL",
            "CREATE_VOTE",
            "MAKE_VOTE",
            "START_VOTE",
            "CREATE_SURVEY",
        ]
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context
            .message
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        Ok(source == "discord")
    }

    async fn handler(
        &self,
        context: &ActionContext,
        service: &DiscordService,
    ) -> Result<ActionResult> {
        let channel_id = Snowflake::new(context.channel_id.clone())?;

        let text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        // Parse poll info from the message
        let poll_info = service.parse_poll_info(text).await?;

        let poll_info = match poll_info {
            Some(info) => info,
            None => {
                return Ok(ActionResult::failure(
                    "I couldn't understand the poll details. \
                    Please specify a question and at least 2 options.",
                ))
            }
        };

        let question = poll_info
            .get("question")
            .and_then(|q| q.as_str())
            .unwrap_or("");
        let options: Vec<String> = poll_info
            .get("options")
            .and_then(|o| o.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .take(10)
                    .collect()
            })
            .unwrap_or_default();
        let use_emojis = poll_info
            .get("use_emojis")
            .and_then(|u| u.as_bool())
            .unwrap_or(true);

        if options.len() < 2 {
            return Ok(ActionResult::failure("A poll needs at least 2 options."));
        }

        // Determine which emojis to use
        let emojis: Vec<&str> = if options.len() == 2
            && options.iter().any(|o| o.to_lowercase().contains("yes"))
            && options.iter().any(|o| o.to_lowercase().contains("no"))
        {
            YES_NO_EMOJIS.to_vec()
        } else if use_emojis {
            NUMBER_EMOJIS[..options.len()].to_vec()
        } else {
            LETTER_EMOJIS[..options.len()].to_vec()
        };

        // Format the poll message
        let mut poll_lines = vec![format!("📊 **POLL: {}**", question), String::new()];
        for (i, option) in options.iter().enumerate() {
            poll_lines.push(format!("{} {}", emojis[i], option));
        }
        poll_lines.push(String::new());
        poll_lines.push("_React to vote!_".to_string());
        let poll_message = poll_lines.join("\n");

        // Send the poll
        let message_id = service
            .send_poll(&channel_id, &poll_message, &emojis[..options.len()])
            .await?;

        match message_id {
            Some(id) => Ok(ActionResult::success_with_data(
                format!(
                    "I've created a poll with {} options. \
                    Users can vote by clicking the reaction emojis!",
                    options.len()
                ),
                serde_json::json!({
                    "message_id": id,
                    "question": question,
                    "options": options,
                }),
            )),
            None => Ok(ActionResult::failure(
                "Failed to create the poll. Please check my permissions.",
            )),
        }
    }
}
