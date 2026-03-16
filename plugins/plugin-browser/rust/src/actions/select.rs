use crate::services::BrowserService;
use crate::types::ActionResult;
use crate::utils::{action_error, parse_select_action, session_error};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::error;

pub const SELECT_ACTION_NAME: &str = "BROWSER_SELECT";
pub const SELECT_SIMILES: &[&str] = &["SELECT_OPTION", "CHOOSE", "PICK"];
pub const SELECT_DESCRIPTION: &str = "Select an option from a dropdown on the webpage";

pub async fn browser_select(service: Arc<BrowserService>, message: &str) -> ActionResult {
    let session = match service.get_or_create_session().await {
        Ok(s) => s,
        Err(e) => {
            let err = session_error(e);
            return ActionResult::failure(err.user_message);
        }
    };

    let (option, dropdown) = parse_select_action(message);

    if option.is_empty() {
        let err = action_error("select", &dropdown, Some("No option specified to select"));
        return ActionResult::failure(err.user_message);
    }

    let client = service.get_client();
    let result = client.select(&session.id, &option, &dropdown).await;

    match result {
        Ok(response) if response.success => {
            let mut data = HashMap::new();
            data.insert(
                "actionName".to_string(),
                serde_json::json!(SELECT_ACTION_NAME),
            );
            data.insert("option".to_string(), serde_json::json!(option));
            data.insert("dropdown".to_string(), serde_json::json!(dropdown));
            data.insert("sessionId".to_string(), serde_json::json!(session.id));

            ActionResult::success(data)
        }
        Ok(response) => {
            let err = action_error("select", &dropdown, response.error.as_deref());
            ActionResult::failure(err.user_message)
        }
        Err(e) => {
            error!("Error in BROWSER_SELECT action: {}", e);
            let err = action_error("select", &dropdown, Some(&e));
            ActionResult::failure(err.user_message)
        }
    }
}
