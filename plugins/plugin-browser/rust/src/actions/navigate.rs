use crate::services::BrowserService;
use crate::types::ActionResult;
use crate::utils::{
    default_configs, default_url_validator, extract_url, navigation_error, no_url_found,
    retry_with_backoff, validate_secure_action,
};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::error;

pub const NAVIGATE_ACTION_NAME: &str = "BROWSER_NAVIGATE";
pub const NAVIGATE_SIMILES: &[&str] = &["GO_TO_URL", "OPEN_WEBSITE", "VISIT_PAGE", "NAVIGATE_TO"];
pub const NAVIGATE_DESCRIPTION: &str = "Navigate the browser to a specified URL";

pub async fn browser_navigate(service: Arc<BrowserService>, message: &str) -> ActionResult {
    let url = match extract_url(message) {
        Some(u) => u,
        None => {
            let err = no_url_found();
            return ActionResult::failure(err.user_message);
        }
    };

    let validator = default_url_validator();
    if let Err(e) = validate_secure_action(Some(&url), &validator) {
        return ActionResult::failure(e.user_message);
    }

    let session = match service.get_or_create_session().await {
        Ok(s) => s,
        Err(e) => return ActionResult::failure(e),
    };

    let client = service.get_client();
    let session_id = session.id.clone();
    let url_clone = url.clone();

    let result = retry_with_backoff(
        || async { client.navigate(&session_id, &url_clone).await },
        &default_configs::navigation(),
        &format!("navigate to {}", url),
    )
    .await;

    match result {
        Ok(nav_result) => {
            let mut data = HashMap::new();
            data.insert(
                "actionName".to_string(),
                serde_json::json!(NAVIGATE_ACTION_NAME),
            );
            data.insert("url".to_string(), serde_json::json!(nav_result.url));
            data.insert("title".to_string(), serde_json::json!(nav_result.title));
            data.insert("sessionId".to_string(), serde_json::json!(session.id));

            ActionResult::success(data)
        }
        Err(e) => {
            error!("Error in BROWSER_NAVIGATE action: {}", e);
            let err = navigation_error(&url, Some(&e));
            ActionResult::failure(err.user_message)
        }
    }
}
