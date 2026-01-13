use crate::services::BrowserService;
use crate::types::ActionResult;
use crate::utils::{action_error, parse_extract_instruction, session_error};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::error;

pub const EXTRACT_ACTION_NAME: &str = "BROWSER_EXTRACT";
pub const EXTRACT_SIMILES: &[&str] = &["EXTRACT_DATA", "GET_TEXT", "SCRAPE"];
pub const EXTRACT_DESCRIPTION: &str = "Extract data from the webpage";

pub async fn browser_extract(service: Arc<BrowserService>, message: &str) -> ActionResult {
    let session = match service.get_or_create_session().await {
        Ok(s) => s,
        Err(e) => {
            let err = session_error(e);
            return ActionResult::failure(err.user_message);
        }
    };

    let instruction = parse_extract_instruction(message);

    let client = service.get_client();
    let result = client.extract(&session.id, &instruction).await;

    match result {
        Ok(response) if response.success => {
            let resp_data = response.data.unwrap_or_default();
            let found = resp_data
                .get("found")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let data_value = resp_data
                .get("data")
                .and_then(|v| v.as_str())
                .unwrap_or("No data found")
                .to_string();

            let mut data = HashMap::new();
            data.insert(
                "actionName".to_string(),
                serde_json::json!(EXTRACT_ACTION_NAME),
            );
            data.insert("instruction".to_string(), serde_json::json!(instruction));
            data.insert("found".to_string(), serde_json::json!(found));
            data.insert("data".to_string(), serde_json::json!(data_value));
            data.insert("sessionId".to_string(), serde_json::json!(session.id));

            ActionResult::success(data)
        }
        Ok(response) => {
            let err = action_error("extract", "page", response.error.as_deref());
            ActionResult::failure(err.user_message)
        }
        Err(e) => {
            error!("Error in BROWSER_EXTRACT action: {}", e);
            let err = action_error("extract", "page", Some(&e));
            ActionResult::failure(err.user_message)
        }
    }
}
