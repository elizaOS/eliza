use crate::actions::{
    browser_click, browser_extract, browser_navigate, browser_screenshot, browser_select,
    browser_type,
};
use crate::providers::get_browser_state;
use crate::services::BrowserService;
use crate::types::{ActionResult, BrowserConfig};
use std::env;
use std::sync::Arc;
use tracing::info;

pub struct BrowserPlugin {
    pub name: String,
    pub description: String,
    pub config: BrowserConfig,
    pub service: Option<Arc<BrowserService>>,
}

impl BrowserPlugin {
    pub fn new(config: BrowserConfig) -> Self {
        Self {
            name: "plugin-browser".to_string(),
            description: "Browser automation plugin".to_string(),
            config,
            service: None,
        }
    }

    pub async fn init(&mut self) -> Result<(), String> {
        info!("Initializing browser automation plugin");

        self.config = BrowserConfig {
            headless: env::var("BROWSER_HEADLESS")
                .map(|v| v.to_lowercase() == "true")
                .unwrap_or(true),
            browserbase_api_key: env::var("BROWSERBASE_API_KEY").ok(),
            browserbase_project_id: env::var("BROWSERBASE_PROJECT_ID").ok(),
            openai_api_key: env::var("OPENAI_API_KEY").ok(),
            anthropic_api_key: env::var("ANTHROPIC_API_KEY").ok(),
            ollama_base_url: env::var("OLLAMA_BASE_URL").ok(),
            ollama_model: env::var("OLLAMA_MODEL").ok(),
            capsolver_api_key: env::var("CAPSOLVER_API_KEY").ok(),
            server_port: env::var("BROWSER_SERVER_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3456),
        };

        let service = BrowserService::new(self.config.clone());
        service.start().await?;
        self.service = Some(Arc::new(service));

        info!("Browser plugin initialized successfully");
        Ok(())
    }

    pub async fn stop(&mut self) {
        info!("Stopping browser automation plugin");
        if let Some(service) = &self.service {
            service.stop().await;
        }
        self.service = None;
    }

    pub async fn handle_action(
        &self,
        action_name: &str,
        message: &str,
    ) -> Result<ActionResult, String> {
        let service = self
            .service
            .as_ref()
            .ok_or("Browser service not initialized")?;

        match action_name {
            "BROWSER_NAVIGATE" => Ok(browser_navigate(Arc::clone(service), message).await),
            "BROWSER_CLICK" => Ok(browser_click(Arc::clone(service), message).await),
            "BROWSER_TYPE" => Ok(browser_type(Arc::clone(service), message).await),
            "BROWSER_SELECT" => Ok(browser_select(Arc::clone(service), message).await),
            "BROWSER_EXTRACT" => Ok(browser_extract(Arc::clone(service), message).await),
            "BROWSER_SCREENSHOT" => Ok(browser_screenshot(Arc::clone(service), message).await),
            _ => Err(format!("Unknown action: {}", action_name)),
        }
    }

    pub async fn get_provider(&self, provider_name: &str) -> Result<serde_json::Value, String> {
        let service = self
            .service
            .as_ref()
            .ok_or("Browser service not initialized")?;

        match provider_name {
            "BROWSER_STATE" => {
                let result = get_browser_state(Arc::clone(service)).await;
                Ok(serde_json::json!({
                    "text": result.text,
                    "values": result.values,
                    "data": result.data,
                }))
            }
            _ => Err(format!("Unknown provider: {}", provider_name)),
        }
    }
}

pub fn create_browser_plugin(config: Option<BrowserConfig>) -> BrowserPlugin {
    BrowserPlugin::new(config.unwrap_or_default())
}
