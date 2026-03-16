use crate::services::BrowserService;
use crate::types::ActionResult;
use crate::utils::{action_error, session_error};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::error;

pub const SCREENSHOT_ACTION_NAME: &str = "BROWSER_SCREENSHOT";
pub const SCREENSHOT_SIMILES: &[&str] = &["TAKE_SCREENSHOT", "CAPTURE_PAGE", "SCREENSHOT"];
pub const SCREENSHOT_DESCRIPTION: &str = "Take a screenshot of the current page";

pub async fn browser_screenshot(service: Arc<BrowserService>, _message: &str) -> ActionResult {
    let session = match service.get_or_create_session().await {
        Ok(s) => s,
        Err(e) => {
            let err = session_error(e);
            return ActionResult::failure(err.user_message);
        }
    };

    let client = service.get_client();
    let result = client.screenshot(&session.id).await;

    match result {
        Ok(response) if response.success => {
            let resp_data = response.data.unwrap_or_default();
            let url = resp_data
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let title = resp_data
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled")
                .to_string();
            let screenshot = resp_data.get("screenshot").cloned();

            let mut data = HashMap::new();
            data.insert(
                "actionName".to_string(),
                serde_json::json!(SCREENSHOT_ACTION_NAME),
            );
            data.insert("url".to_string(), serde_json::json!(url));
            data.insert("title".to_string(), serde_json::json!(title));
            data.insert("sessionId".to_string(), serde_json::json!(session.id));
            if let Some(s) = screenshot {
                data.insert("screenshot".to_string(), s);
            }

            ActionResult::success(data)
        }
        Ok(response) => {
            let err = action_error("screenshot", "page", response.error.as_deref());
            ActionResult::failure(err.user_message)
        }
        Err(e) => {
            error!("Error in BROWSER_SCREENSHOT action: {}", e);
            let err = action_error("screenshot", "page", Some(&e));
            ActionResult::failure(err.user_message)
        }
    }
}
