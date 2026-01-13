use crate::services::BrowserService;
use crate::types::ActionResult;
use crate::utils::{action_error, parse_type_action, session_error};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::error;

pub const TYPE_ACTION_NAME: &str = "BROWSER_TYPE";
pub const TYPE_SIMILES: &[&str] = &["TYPE_TEXT", "INPUT", "ENTER_TEXT"];
pub const TYPE_DESCRIPTION: &str = "Type text into an input field on the webpage";

pub async fn browser_type(service: Arc<BrowserService>, message: &str) -> ActionResult {
    let session = match service.get_or_create_session().await {
        Ok(s) => s,
        Err(e) => {
            let err = session_error(e);
            return ActionResult::failure(err.user_message);
        }
    };

    let (text_to_type, field) = parse_type_action(message);

    if text_to_type.is_empty() {
        let err = action_error("type", &field, Some("No text specified to type"));
        return ActionResult::failure(err.user_message);
    }

    let client = service.get_client();
    let result = client.type_text(&session.id, &text_to_type, &field).await;

    match result {
        Ok(response) if response.success => {
            let mut data = HashMap::new();
            data.insert(
                "actionName".to_string(),
                serde_json::json!(TYPE_ACTION_NAME),
            );
            data.insert("textTyped".to_string(), serde_json::json!(text_to_type));
            data.insert("field".to_string(), serde_json::json!(field));
            data.insert("sessionId".to_string(), serde_json::json!(session.id));

            ActionResult::success(data)
        }
        Ok(response) => {
            let err = action_error("type", &field, response.error.as_deref());
            ActionResult::failure(err.user_message)
        }
        Err(e) => {
            error!("Error in BROWSER_TYPE action: {}", e);
            let err = action_error("type", &field, Some(&e));
            ActionResult::failure(err.user_message)
        }
    }
}
