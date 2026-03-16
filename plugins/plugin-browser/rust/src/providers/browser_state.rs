use crate::services::BrowserService;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::error;

pub const BROWSER_STATE_NAME: &str = "BROWSER_STATE";
pub const BROWSER_STATE_DESCRIPTION: &str = "Provides current browser state information";

#[derive(Debug)]
pub struct ProviderResult {
    pub text: String,
    pub values: HashMap<String, serde_json::Value>,
    pub data: HashMap<String, serde_json::Value>,
}

pub async fn get_browser_state(service: Arc<BrowserService>) -> ProviderResult {
    let session = match service.get_current_session().await {
        Some(s) => s,
        None => {
            return ProviderResult {
                text: "No active browser session".to_string(),
                values: [("hasSession".to_string(), serde_json::json!(false))]
                    .into_iter()
                    .collect(),
                data: HashMap::new(),
            };
        }
    };

    let client = service.get_client();

    match client.get_state(&session.id).await {
        Ok(state) => {
            let url = state
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let title = state
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            ProviderResult {
                text: format!("Current browser page: \"{}\" at {}", title, url),
                values: [
                    ("hasSession".to_string(), serde_json::json!(true)),
                    ("url".to_string(), serde_json::json!(url)),
                    ("title".to_string(), serde_json::json!(title)),
                ]
                .into_iter()
                .collect(),
                data: [
                    ("sessionId".to_string(), serde_json::json!(session.id)),
                    (
                        "createdAt".to_string(),
                        serde_json::json!(session.created_at.to_rfc3339()),
                    ),
                ]
                .into_iter()
                .collect(),
            }
        }
        Err(e) => {
            error!("Error getting browser state: {}", e);
            ProviderResult {
                text: "Error getting browser state".to_string(),
                values: [
                    ("hasSession".to_string(), serde_json::json!(true)),
                    ("error".to_string(), serde_json::json!(true)),
                ]
                .into_iter()
                .collect(),
                data: HashMap::new(),
            }
        }
    }
}
