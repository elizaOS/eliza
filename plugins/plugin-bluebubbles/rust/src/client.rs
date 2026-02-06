//! BlueBubbles API client

use crate::config::BlueBubblesConfig;
use crate::error::{BlueBubblesError, Result};
use crate::types::{
    BlueBubblesChat, BlueBubblesMessage, BlueBubblesProbeResult, BlueBubblesServerInfo,
    SendMessageOptions, SendMessageResult,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tracing::{debug, error, info};

/// API response wrapper
#[derive(Debug, Deserialize)]
struct ApiResponse<T> {
    data: T,
}

/// BlueBubbles API client
pub struct BlueBubblesClient {
    client: Client,
    base_url: String,
    password: String,
}

impl BlueBubblesClient {
    /// Creates a new client
    pub fn new(config: &BlueBubblesConfig) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("Failed to create HTTP client");

        Self {
            client,
            base_url: config.server_url.trim_end_matches('/').to_string(),
            password: config.password.clone(),
        }
    }

    /// Builds a URL with password authentication
    fn build_url(&self, endpoint: &str) -> String {
        let separator = if endpoint.contains('?') { "&" } else { "?" };
        format!(
            "{}{}{}password={}",
            self.base_url, endpoint, separator, self.password
        )
    }

    /// Makes a GET request
    async fn get<T: for<'de> Deserialize<'de>>(&self, endpoint: &str) -> Result<T> {
        let url = self.build_url(endpoint);
        debug!("GET {}", endpoint);

        let response = self.client.get(&url).send().await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(BlueBubblesError::api(status, body));
        }

        let api_response: ApiResponse<T> = response.json().await?;
        Ok(api_response.data)
    }

    /// Makes a POST request
    async fn post<T: for<'de> Deserialize<'de>, B: Serialize>(
        &self,
        endpoint: &str,
        body: &B,
    ) -> Result<T> {
        let url = self.build_url(endpoint);
        debug!("POST {}", endpoint);

        let response = self.client.post(&url).json(body).send().await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(BlueBubblesError::api(status, body));
        }

        let api_response: ApiResponse<T> = response.json().await?;
        Ok(api_response.data)
    }

    /// Probes the server to check connectivity
    pub async fn probe(&self, timeout_ms: u64) -> BlueBubblesProbeResult {
        let client = Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build()
            .unwrap_or_else(|_| self.client.clone());

        let url = self.build_url("/api/v1/server/info");

        match client.get(&url).send().await {
            Ok(response) => {
                if !response.status().is_success() {
                    return BlueBubblesProbeResult {
                        ok: false,
                        error: Some(format!("HTTP {}", response.status())),
                        ..Default::default()
                    };
                }

                match response.json::<ApiResponse<BlueBubblesServerInfo>>().await {
                    Ok(api_response) => {
                        let info = api_response.data;
                        BlueBubblesProbeResult {
                            ok: true,
                            server_version: Some(info.server_version),
                            os_version: Some(info.os_version),
                            private_api_enabled: Some(info.private_api),
                            helper_connected: Some(info.helper_connected),
                            error: None,
                        }
                    }
                    Err(e) => BlueBubblesProbeResult {
                        ok: false,
                        error: Some(format!("Parse error: {}", e)),
                        ..Default::default()
                    },
                }
            }
            Err(e) => BlueBubblesProbeResult {
                ok: false,
                error: Some(format!("Connection error: {}", e)),
                ..Default::default()
            },
        }
    }

    /// Sends a text message
    pub async fn send_message(
        &self,
        chat_guid: &str,
        text: &str,
        options: Option<SendMessageOptions>,
    ) -> Result<SendMessageResult> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct SendMessageRequest {
            chat_guid: String,
            message: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            temp_guid: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            method: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            subject: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            effect_id: Option<String>,
        }

        let opts = options.unwrap_or_default();
        let request = SendMessageRequest {
            chat_guid: chat_guid.to_string(),
            message: text.to_string(),
            temp_guid: opts.temp_guid,
            method: opts.method.or_else(|| Some("apple-script".to_string())),
            subject: opts.subject,
            effect_id: opts.effect_id,
        };

        let message: BlueBubblesMessage = self.post("/api/v1/message/text", &request).await?;

        info!("Sent message: {}", message.guid);

        Ok(SendMessageResult {
            guid: message.guid,
            temp_guid: None,
            status: "sent".to_string(),
            date_created: message.date_created,
            text: message.text.unwrap_or_else(|| text.to_string()),
            error: None,
        })
    }

    /// Gets information about a chat
    pub async fn get_chat(&self, chat_guid: &str) -> Result<BlueBubblesChat> {
        let endpoint = format!("/api/v1/chat/{}", urlencoding::encode(chat_guid));
        self.get(&endpoint).await
    }

    /// Lists all chats
    pub async fn list_chats(&self, limit: u32, offset: u32) -> Result<Vec<BlueBubblesChat>> {
        let endpoint = format!(
            "/api/v1/chat?limit={}&offset={}&with=lastMessage,participants",
            limit, offset
        );
        self.get(&endpoint).await
    }

    /// Gets messages for a chat
    pub async fn get_messages(
        &self,
        chat_guid: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<BlueBubblesMessage>> {
        let endpoint = format!(
            "/api/v1/chat/{}/message?limit={}&offset={}",
            urlencoding::encode(chat_guid),
            limit,
            offset
        );
        self.get(&endpoint).await
    }

    /// Marks a chat as read
    pub async fn mark_chat_read(&self, chat_guid: &str) -> Result<()> {
        let endpoint = format!("/api/v1/chat/{}/read", urlencoding::encode(chat_guid));
        let _: serde_json::Value = self.post(&endpoint, &serde_json::json!({})).await?;
        Ok(())
    }

    /// Sends a reaction to a message
    pub async fn react_to_message(
        &self,
        chat_guid: &str,
        message_guid: &str,
        reaction: &str,
    ) -> Result<()> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct ReactRequest {
            chat_guid: String,
            message_guid: String,
            reaction: String,
        }

        let request = ReactRequest {
            chat_guid: chat_guid.to_string(),
            message_guid: message_guid.to_string(),
            reaction: reaction.to_string(),
        };

        let _: serde_json::Value = self.post("/api/v1/message/react", &request).await?;
        Ok(())
    }

    /// Edits a message (requires private API)
    pub async fn edit_message(&self, message_guid: &str, new_text: &str) -> Result<()> {
        let endpoint = format!(
            "/api/v1/message/{}/edit",
            urlencoding::encode(message_guid)
        );

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct EditRequest {
            edited_message: String,
            backwards_compatibility_message: String,
        }

        let request = EditRequest {
            edited_message: new_text.to_string(),
            backwards_compatibility_message: new_text.to_string(),
        };

        let _: serde_json::Value = self.post(&endpoint, &request).await?;
        Ok(())
    }

    /// Unsends a message (requires private API)
    pub async fn unsend_message(&self, message_guid: &str) -> Result<()> {
        let endpoint = format!(
            "/api/v1/message/{}/unsend",
            urlencoding::encode(message_guid)
        );
        let _: serde_json::Value = self.post(&endpoint, &serde_json::json!({})).await?;
        Ok(())
    }

    /// Resolves a target to a chat GUID
    pub async fn resolve_target(&self, target: &str) -> Result<String> {
        // If it already looks like a chat GUID, return it
        if target.starts_with("iMessage;") || target.starts_with("SMS;") {
            return Ok(target.to_string());
        }

        // If it looks like a chat ID, query for it
        if target.starts_with("chat_") {
            let chats = self.list_chats(100, 0).await?;
            if let Some(chat) = chats.iter().find(|c| {
                c.chat_identifier == target
                    || c.guid == target
                    || c.chat_identifier.contains(target)
            }) {
                return Ok(chat.guid.clone());
            }
        }

        // Otherwise, construct a DM chat GUID
        Ok(format!("iMessage;-;{}", target))
    }

    /// Creates a new group chat
    pub async fn create_group_chat(
        &self,
        participants: &[String],
        name: Option<&str>,
        message: Option<&str>,
    ) -> Result<BlueBubblesChat> {
        #[derive(Serialize)]
        struct CreateChatRequest {
            participants: Vec<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            name: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            message: Option<String>,
        }

        let request = CreateChatRequest {
            participants: participants.to_vec(),
            name: name.map(String::from),
            message: message.map(String::from),
        };

        self.post("/api/v1/chat", &request).await
    }
}

impl Default for BlueBubblesProbeResult {
    fn default() -> Self {
        Self {
            ok: false,
            server_version: None,
            os_version: None,
            private_api_enabled: None,
            helper_connected: None,
            error: None,
        }
    }
}
