//! CloudAuthService — Device-based auto-signup and session management.

use std::collections::HashMap;
use tracing::{info, warn};

use crate::cloud_api::CloudApiClient;
use crate::cloud_types::{CloudCredentials, CloudPluginConfig};
use crate::error::{ElizaCloudError, Result};

/// ElizaCloud device authentication and session management.
pub struct CloudAuthService {
    client: CloudApiClient,
    credentials: Option<CloudCredentials>,
}

impl CloudAuthService {
    /// Create a new auth service with default configuration.
    pub fn new() -> Result<Self> {
        let config = CloudPluginConfig::default();
        let client = CloudApiClient::new(&config.base_url, None)?;
        Ok(Self {
            client,
            credentials: None,
        })
    }

    /// Initialize with runtime settings.
    pub async fn start(&mut self, settings: &HashMap<String, String>) -> Result<()> {
        let base_url = settings
            .get("ELIZAOS_CLOUD_BASE_URL")
            .map(String::as_str)
            .unwrap_or("https://www.elizacloud.ai/api/v1");
        self.client.set_base_url(base_url);

        // Try existing API key
        if let Some(key) = settings.get("ELIZAOS_CLOUD_API_KEY") {
            self.client.set_api_key(key);
            if self.validate_api_key(key).await {
                self.credentials = Some(CloudCredentials {
                    api_key: key.clone(),
                    user_id: settings.get("ELIZAOS_CLOUD_USER_ID").cloned().unwrap_or_default(),
                    organization_id: settings.get("ELIZAOS_CLOUD_ORG_ID").cloned().unwrap_or_default(),
                    authenticated_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs_f64(),
                });
                info!("[CloudAuth] Authenticated with existing API key");
                return Ok(());
            }
            warn!("[CloudAuth] Existing API key invalid");
        }

        let enabled = settings.get("ELIZAOS_CLOUD_ENABLED").map(String::as_str);
        if enabled == Some("true") || enabled == Some("1") {
            self.authenticate_with_device().await?;
        } else {
            info!("[CloudAuth] Cloud not enabled (set ELIZAOS_CLOUD_ENABLED=true)");
        }

        Ok(())
    }

    /// Stop the service and clear credentials.
    pub async fn stop(&mut self) {
        self.credentials = None;
    }

    async fn validate_api_key(&self, key: &str) -> bool {
        let url = format!("{}/models", self.client.base_url());
        let result = reqwest::Client::new()
            .get(&url)
            .header("Authorization", format!("Bearer {}", key))
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await;
        matches!(result, Ok(resp) if resp.status().is_success())
    }

    /// Perform device-based auto-signup.
    pub async fn authenticate_with_device(&mut self) -> Result<CloudCredentials> {
        let device_id = derive_device_id();
        let platform = detect_platform();
        let app_version = std::env::var("ELIZAOS_CLOUD_APP_VERSION")
            .unwrap_or_else(|_| "2.0.0-alpha".to_string());

        info!("[CloudAuth] Authenticating device (platform={})", platform);

        let body = serde_json::json!({
            "deviceId": device_id,
            "platform": platform,
            "appVersion": app_version,
            "deviceName": hostname::get()
                .ok()
                .and_then(|h| h.into_string().ok())
                .unwrap_or_else(|| "unknown".to_string()),
        });

        let resp = self.client.post_unauthenticated("/device-auth", &body).await?;
        let data = resp
            .get("data")
            .ok_or_else(|| ElizaCloudError::invalid_request("Missing data in response", vec![]))?;

        let api_key = data["apiKey"].as_str().unwrap_or_default().to_string();
        let user_id = data["userId"].as_str().unwrap_or_default().to_string();
        let org_id = data["organizationId"].as_str().unwrap_or_default().to_string();
        let credits = data["credits"].as_f64().unwrap_or(0.0);
        let is_new = data["isNew"].as_bool().unwrap_or(false);

        self.client.set_api_key(&api_key);

        let creds = CloudCredentials {
            api_key,
            user_id,
            organization_id: org_id,
            authenticated_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64(),
        };
        self.credentials = Some(creds.clone());

        let action = if is_new { "New account created" } else { "Authenticated" };
        info!("[CloudAuth] {} (credits: ${:.2})", action, credits);

        Ok(creds)
    }

    pub fn is_authenticated(&self) -> bool {
        self.credentials.is_some()
    }

    pub fn credentials(&self) -> Option<&CloudCredentials> {
        self.credentials.as_ref()
    }

    pub fn api_key(&self) -> Option<&str> {
        self.credentials
            .as_ref()
            .map(|c| c.api_key.as_str())
            .or_else(|| self.client.api_key())
    }

    pub fn client(&self) -> &CloudApiClient {
        &self.client
    }

    pub fn client_mut(&mut self) -> &mut CloudApiClient {
        &mut self.client
    }

    pub fn user_id(&self) -> Option<&str> {
        self.credentials.as_ref().map(|c| c.user_id.as_str())
    }

    pub fn organization_id(&self) -> Option<&str> {
        self.credentials.as_ref().map(|c| c.organization_id.as_str())
    }
}

fn derive_device_id() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let hostname = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown".to_string());

    let mut hasher = DefaultHasher::new();
    hostname.hash(&mut hasher);
    std::env::consts::OS.hash(&mut hasher);
    std::env::consts::ARCH.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn detect_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        _ => "linux",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_device_id_deterministic() {
        let id1 = derive_device_id();
        let id2 = derive_device_id();
        assert_eq!(id1, id2);
        assert!(!id1.is_empty());
    }

    #[test]
    fn test_detect_platform() {
        let plat = detect_platform();
        assert!(["macos", "windows", "linux"].contains(&plat));
    }

    #[test]
    fn test_new_service_not_authenticated() {
        let svc = CloudAuthService::new().unwrap();
        assert!(!svc.is_authenticated());
        assert!(svc.credentials().is_none());
        assert!(svc.user_id().is_none());
    }
}
