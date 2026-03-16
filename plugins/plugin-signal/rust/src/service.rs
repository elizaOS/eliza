//! Signal service implementation for elizaOS.
//!
//! This service provides Signal messaging capabilities via the Signal CLI REST API.

use crate::types::*;
use reqwest::Client;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};
use url::Url;

/// Signal messaging service for elizaOS agents.
pub struct SignalService {
    settings: SignalSettings,
    client: Client,
    base_url: Url,
    connected: Arc<RwLock<bool>>,
    contacts_cache: Arc<RwLock<HashMap<String, SignalContact>>>,
    groups_cache: Arc<RwLock<HashMap<String, SignalGroup>>>,
}

impl SignalService {
    /// Create a new Signal service with the given settings.
    pub async fn new(settings: SignalSettings) -> Result<Self, SignalPluginError> {
        // Validate settings
        if settings.account_number.is_empty() {
            return Err(SignalPluginError::Configuration {
                message: "SIGNAL_ACCOUNT_NUMBER is required".to_string(),
                setting_name: Some("SIGNAL_ACCOUNT_NUMBER".to_string()),
            });
        }

        let normalized = normalize_e164(&settings.account_number).ok_or_else(|| {
            SignalPluginError::Configuration {
                message: format!(
                    "Invalid phone number format: {}. Must be E.164 format.",
                    settings.account_number
                ),
                setting_name: Some("SIGNAL_ACCOUNT_NUMBER".to_string()),
            }
        })?;

        if settings.http_url.is_none() && settings.cli_path.is_none() {
            return Err(SignalPluginError::Configuration {
                message: "Either SIGNAL_HTTP_URL or SIGNAL_CLI_PATH must be provided".to_string(),
                setting_name: None,
            });
        }

        let base_url = if let Some(ref url) = settings.http_url {
            Url::parse(url)?
        } else {
            return Err(SignalPluginError::Configuration {
                message: "HTTP URL is required for Rust implementation".to_string(),
                setting_name: Some("SIGNAL_HTTP_URL".to_string()),
            });
        };

        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;

        let service = Self {
            settings: SignalSettings {
                account_number: normalized,
                ..settings
            },
            client,
            base_url,
            connected: Arc::new(RwLock::new(false)),
            contacts_cache: Arc::new(RwLock::new(HashMap::new())),
            groups_cache: Arc::new(RwLock::new(HashMap::new())),
        };

        // Verify connection
        service.verify_connection().await?;

        // Load initial data
        service.load_contacts().await?;
        service.load_groups().await?;

        *service.connected.write().await = true;

        info!(
            "Signal service initialized for account {}",
            service.settings.account_number
        );

        Ok(service)
    }

    /// Create service from environment settings.
    pub async fn from_env(
        get_setting: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, SignalPluginError> {
        let account_number = get_setting("SIGNAL_ACCOUNT_NUMBER").ok_or_else(|| {
            SignalPluginError::Configuration {
                message: "SIGNAL_ACCOUNT_NUMBER is required".to_string(),
                setting_name: Some("SIGNAL_ACCOUNT_NUMBER".to_string()),
            }
        })?;

        let http_url = get_setting("SIGNAL_HTTP_URL");
        let cli_path = get_setting("SIGNAL_CLI_PATH");
        let ignore_groups = get_setting("SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES")
            .map(|v| v.to_lowercase() == "true")
            .unwrap_or(false);

        let settings = SignalSettings {
            account_number,
            http_url,
            cli_path,
            should_ignore_group_messages: ignore_groups,
            ..Default::default()
        };

        Self::new(settings).await
    }

    /// Verify the connection to the Signal API.
    async fn verify_connection(&self) -> Result<(), SignalPluginError> {
        let url = self.base_url.join("/v1/about")?;
        let response = self.client.get(url).send().await?;

        if !response.status().is_success() {
            return Err(SignalPluginError::Api {
                message: format!(
                    "Failed to connect to Signal API: {}",
                    response.status()
                ),
                status_code: Some(response.status().as_u16()),
                response_body: None,
            });
        }

        Ok(())
    }

    /// Make an API request to the Signal CLI REST API.
    async fn api_request<T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        endpoint: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T, SignalPluginError> {
        let url = self.base_url.join(endpoint)?;

        let mut request = self.client.request(method, url);

        if let Some(data) = body {
            request = request.json(&data);
        }

        let response = request.send().await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.ok();
            return Err(SignalPluginError::Api {
                message: format!("Signal API error: {}", status),
                status_code: Some(status),
                response_body: body,
            });
        }

        let text = response.text().await?;
        if text.is_empty() {
            // Return default for empty response
            return serde_json::from_str("null").map_err(Into::into);
        }

        serde_json::from_str(&text).map_err(Into::into)
    }

    /// Load contacts from Signal.
    async fn load_contacts(&self) -> Result<(), SignalPluginError> {
        let endpoint = format!("/v1/contacts/{}", self.settings.account_number);
        let contacts: Vec<SignalContact> =
            self.api_request(reqwest::Method::GET, &endpoint, None).await?;

        let mut cache = self.contacts_cache.write().await;
        cache.clear();
        for contact in contacts {
            cache.insert(contact.number.clone(), contact);
        }

        debug!("Loaded {} contacts", cache.len());
        Ok(())
    }

    /// Load groups from Signal.
    async fn load_groups(&self) -> Result<(), SignalPluginError> {
        let endpoint = format!("/v1/groups/{}", self.settings.account_number);
        let groups: Vec<SignalGroup> =
            self.api_request(reqwest::Method::GET, &endpoint, None).await?;

        let mut cache = self.groups_cache.write().await;
        cache.clear();
        for group in groups {
            cache.insert(group.id.clone(), group);
        }

        debug!("Loaded {} groups", cache.len());
        Ok(())
    }

    /// Check if the service is connected.
    pub async fn is_connected(&self) -> bool {
        *self.connected.read().await
    }

    /// Get the configured account number.
    pub fn get_account_number(&self) -> &str {
        &self.settings.account_number
    }

    /// Get a contact by phone number.
    pub async fn get_contact(&self, number: &str) -> Option<SignalContact> {
        let normalized = normalize_e164(number)?;
        self.contacts_cache.read().await.get(&normalized).cloned()
    }

    /// Get a group from cache.
    pub async fn get_cached_group(&self, group_id: &str) -> Option<SignalGroup> {
        self.groups_cache.read().await.get(group_id).cloned()
    }

    /// Send a direct message to a recipient.
    pub async fn send_message(
        &self,
        recipient: &str,
        text: &str,
        options: Option<SignalMessageSendOptions>,
    ) -> Result<SendMessageResult, SignalPluginError> {
        let normalized = normalize_e164(recipient)
            .ok_or_else(|| SignalPluginError::InvalidPhoneNumber(recipient.to_string()))?;

        let mut data = json!({
            "message": text,
            "number": self.settings.account_number,
            "recipients": [normalized],
        });

        if let Some(opts) = options {
            if let (Some(ts), Some(author)) = (opts.quote_timestamp, opts.quote_author) {
                data["quote"] = json!({
                    "id": ts,
                    "author": author,
                });
            }
            if !opts.attachments.is_empty() {
                data["base64_attachments"] = json!(opts.attachments);
            }
        }

        let result: serde_json::Value =
            self.api_request(reqwest::Method::POST, "/v2/send", Some(data)).await?;

        let timestamp = result["timestamp"].as_i64().unwrap_or(0);

        info!("Sent message to {} (timestamp: {})", normalized, timestamp);

        Ok(SendMessageResult { timestamp })
    }

    /// Send a message to a group.
    pub async fn send_group_message(
        &self,
        group_id: &str,
        text: &str,
        options: Option<SignalMessageSendOptions>,
    ) -> Result<SendMessageResult, SignalPluginError> {
        if !is_valid_group_id(group_id) {
            return Err(SignalPluginError::InvalidGroupId(group_id.to_string()));
        }

        let mut data = json!({
            "message": text,
            "number": self.settings.account_number,
            "recipients": [group_id],
        });

        if let Some(opts) = options {
            if let (Some(ts), Some(author)) = (opts.quote_timestamp, opts.quote_author) {
                data["quote"] = json!({
                    "id": ts,
                    "author": author,
                });
            }
            if !opts.attachments.is_empty() {
                data["base64_attachments"] = json!(opts.attachments);
            }
        }

        let result: serde_json::Value =
            self.api_request(reqwest::Method::POST, "/v2/send", Some(data)).await?;

        let timestamp = result["timestamp"].as_i64().unwrap_or(0);

        info!(
            "Sent group message to {} (timestamp: {})",
            group_id, timestamp
        );

        Ok(SendMessageResult { timestamp })
    }

    /// Send a reaction to a message.
    pub async fn send_reaction(
        &self,
        recipient: &str,
        emoji: &str,
        target_timestamp: i64,
        target_author: &str,
    ) -> Result<SendReactionResult, SignalPluginError> {
        let endpoint = format!("/v1/reactions/{}", self.settings.account_number);

        let data = json!({
            "recipient": recipient,
            "reaction": {
                "emoji": emoji,
                "target_author": target_author,
                "target_sent_timestamp": target_timestamp,
            },
        });

        self.api_request::<serde_json::Value>(reqwest::Method::POST, &endpoint, Some(data))
            .await?;

        Ok(SendReactionResult { success: true })
    }

    /// Remove a reaction from a message.
    pub async fn remove_reaction(
        &self,
        recipient: &str,
        emoji: &str,
        target_timestamp: i64,
        target_author: &str,
    ) -> Result<SendReactionResult, SignalPluginError> {
        let endpoint = format!("/v1/reactions/{}", self.settings.account_number);

        let data = json!({
            "recipient": recipient,
            "reaction": {
                "emoji": emoji,
                "target_author": target_author,
                "target_sent_timestamp": target_timestamp,
                "remove": true,
            },
        });

        self.api_request::<serde_json::Value>(reqwest::Method::POST, &endpoint, Some(data))
            .await?;

        Ok(SendReactionResult { success: true })
    }

    /// Send a typing indicator.
    pub async fn send_typing_indicator(
        &self,
        recipient: &str,
        is_group: bool,
    ) -> Result<(), SignalPluginError> {
        if !self.settings.typing_indicator_enabled {
            return Ok(());
        }

        let endpoint = format!("/v1/typing-indicator/{}", self.settings.account_number);

        let mut data = json!({
            "recipient": recipient,
        });

        if is_group {
            data["group_id"] = json!(recipient);
        }

        self.api_request::<serde_json::Value>(reqwest::Method::PUT, &endpoint, Some(data))
            .await?;

        Ok(())
    }

    /// Stop a typing indicator.
    pub async fn stop_typing_indicator(
        &self,
        recipient: &str,
        is_group: bool,
    ) -> Result<(), SignalPluginError> {
        if !self.settings.typing_indicator_enabled {
            return Ok(());
        }

        let endpoint = format!("/v1/typing-indicator/{}", self.settings.account_number);

        let mut data = json!({
            "recipient": recipient,
        });

        if is_group {
            data["group_id"] = json!(recipient);
        }

        self.api_request::<serde_json::Value>(reqwest::Method::DELETE, &endpoint, Some(data))
            .await?;

        Ok(())
    }

    /// Get all contacts.
    pub async fn get_contacts(&self) -> Result<Vec<SignalContact>, SignalPluginError> {
        self.load_contacts().await?;
        Ok(self.contacts_cache.read().await.values().cloned().collect())
    }

    /// Get all groups.
    pub async fn get_groups(&self) -> Result<Vec<SignalGroup>, SignalPluginError> {
        self.load_groups().await?;
        Ok(self.groups_cache.read().await.values().cloned().collect())
    }

    /// Get a specific group by ID.
    pub async fn get_group(&self, group_id: &str) -> Result<Option<SignalGroup>, SignalPluginError> {
        let endpoint = format!(
            "/v1/groups/{}/{}",
            self.settings.account_number, group_id
        );

        let result: Option<SignalGroup> =
            match self.api_request(reqwest::Method::GET, &endpoint, None).await {
                Ok(group) => Some(group),
                Err(SignalPluginError::Api { status_code: Some(404), .. }) => None,
                Err(e) => return Err(e),
            };

        if let Some(ref group) = result {
            self.groups_cache
                .write()
                .await
                .insert(group.id.clone(), group.clone());
        }

        Ok(result)
    }

    /// Poll for new messages (for external polling loops).
    pub async fn receive_messages(
        &self,
        timeout_secs: u32,
    ) -> Result<Vec<serde_json::Value>, SignalPluginError> {
        let endpoint = format!(
            "/v1/receive/{}?timeout={}",
            self.settings.account_number, timeout_secs
        );

        self.api_request(reqwest::Method::GET, &endpoint, None).await
    }

    /// Check if group messages should be ignored.
    pub fn should_ignore_group_messages(&self) -> bool {
        self.settings.should_ignore_group_messages
    }

    /// Shutdown the service.
    pub async fn stop(&self) {
        *self.connected.write().await = false;
        info!("Signal service stopped");
    }
}
