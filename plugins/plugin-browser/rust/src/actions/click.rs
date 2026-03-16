use crate::services::BrowserService;
use crate::types::ActionResult;
use crate::utils::{action_error, parse_click_target, session_error};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::error;

pub const CLICK_ACTION_NAME: &str = "BROWSER_CLICK";
pub const CLICK_SIMILES: &[&str] = &["CLICK_ELEMENT", "TAP", "PRESS_BUTTON"];
pub const CLICK_DESCRIPTION: &str = "Click on an element on the webpage";

pub async fn browser_click(service: Arc<BrowserService>, message: &str) -> ActionResult {
    let session = match service.get_or_create_session().await {
        Ok(s) => s,
        Err(e) => {
            let err = session_error(e);
            return ActionResult::failure(err.user_message);
        }
    };

    let description = parse_click_target(message);

    let client = service.get_client();
    let result = client.click(&session.id, &description).await;

    match result {
        Ok(response) if response.success => {
            let mut data = HashMap::new();
            data.insert(
                "actionName".to_string(),
                serde_json::json!(CLICK_ACTION_NAME),
            );
            data.insert("element".to_string(), serde_json::json!(description));
            data.insert("sessionId".to_string(), serde_json::json!(session.id));

            ActionResult::success(data)
        }
        Ok(response) => {
            let err = action_error("click", &description, response.error.as_deref());
            ActionResult::failure(err.user_message)
        }
        Err(e) => {
            error!("Error in BROWSER_CLICK action: {}", e);
            let err = action_error("click", &description, Some(&e));
            ActionResult::failure(err.user_message)
        }
    }
}
