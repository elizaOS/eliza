//! Zalo API client implementation.

use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::{Result, ZaloError};
use crate::types::{ZaloApiResponse, ZaloOAInfo, ZaloSendImageParams, ZaloSendMessageParams};

/// Zalo Official Account API base URL.
pub const ZALO_OA_API_BASE: &str = "https://openapi.zalo.me/v2.0/oa";

/// Zalo OAuth API base URL.
pub const ZALO_OAUTH_API_BASE: &str = "https://oauth.zaloapp.com/v4";

/// Maximum message length for Zalo (characters).
pub const MAX_MESSAGE_LENGTH: usize = 2000;

/// Zalo API client.
pub struct ZaloClient {
    client: Client,
    access_token: String,
}

impl ZaloClient {
    /// Creates a new Zalo API client.
    pub fn new(access_token: String) -> Self {
        Self {
            client: Client::new(),
            access_token,
        }
    }

    /// Creates a new client with a proxy.
    pub fn with_proxy(access_token: String, proxy_url: &str) -> Result<Self> {
        let proxy = reqwest::Proxy::all(proxy_url)
            .map_err(|e| ZaloError::ConfigError(format!("Invalid proxy URL: {}", e)))?;
        
        let client = Client::builder()
            .proxy(proxy)
            .build()
            .map_err(|e| ZaloError::ConfigError(format!("Failed to create client: {}", e)))?;

        Ok(Self {
            client,
            access_token,
        })
    }

    /// Updates the access token.
    pub fn set_access_token(&mut self, token: String) {
        self.access_token = token;
    }

    /// Get OA information.
    pub async fn get_oa_info(&self) -> Result<ZaloOAInfo> {
        let url = format!("{}/getoa", ZALO_OA_API_BASE);
        
        let response = self
            .client
            .get(&url)
            .header("access_token", &self.access_token)
            .send()
            .await?;

        let data: ZaloApiResponse<OAInfoResponse> = response.json().await?;

        if data.error != 0 {
            return Err(ZaloError::ApiError(data.message));
        }

        let oa_data = data.data.ok_or_else(|| ZaloError::ApiError("No OA data returned".to_string()))?;

        Ok(ZaloOAInfo {
            oa_id: oa_data.oa_id,
            name: oa_data.name,
            description: oa_data.description,
            avatar: oa_data.avatar,
            cover: oa_data.cover,
        })
    }

    /// Send a text message.
    pub async fn send_message(&self, params: &ZaloSendMessageParams) -> Result<String> {
        let url = format!("{}/message", ZALO_OA_API_BASE);

        let body = MessageRequest {
            recipient: Recipient {
                user_id: params.user_id.clone(),
            },
            message: TextMessage {
                text: params.text.chars().take(MAX_MESSAGE_LENGTH).collect(),
            },
        };

        let response = self
            .client
            .post(&url)
            .header("access_token", &self.access_token)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        let data: ZaloApiResponse<MessageResponse> = response.json().await?;

        if data.error != 0 {
            return Err(ZaloError::MessageSendFailed(data.message));
        }

        let msg_data = data.data.ok_or_else(|| {
            ZaloError::MessageSendFailed("No message ID returned".to_string())
        })?;

        Ok(msg_data.message_id)
    }

    /// Send an image message.
    pub async fn send_image(&self, params: &ZaloSendImageParams) -> Result<String> {
        let url = format!("{}/message", ZALO_OA_API_BASE);

        let body = ImageMessageRequest {
            recipient: Recipient {
                user_id: params.user_id.clone(),
            },
            message: ImageMessage {
                text: params.caption.clone(),
                attachment: ImageAttachment {
                    attachment_type: "template".to_string(),
                    payload: ImagePayload {
                        template_type: "media".to_string(),
                        elements: vec![ImageElement {
                            media_type: "image".to_string(),
                            url: params.image_url.clone(),
                        }],
                    },
                },
            },
        };

        let response = self
            .client
            .post(&url)
            .header("access_token", &self.access_token)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        let data: ZaloApiResponse<MessageResponse> = response.json().await?;

        if data.error != 0 {
            return Err(ZaloError::MessageSendFailed(data.message));
        }

        let msg_data = data.data.ok_or_else(|| {
            ZaloError::MessageSendFailed("No message ID returned".to_string())
        })?;

        Ok(msg_data.message_id)
    }

    /// Get user profile.
    pub async fn get_user_profile(&self, user_id: &str) -> Result<UserProfile> {
        let data = serde_json::json!({ "user_id": user_id });
        let url = format!(
            "{}/getprofile?data={}",
            ZALO_OA_API_BASE,
            urlencoding::encode(&data.to_string())
        );

        let response = self
            .client
            .get(&url)
            .header("access_token", &self.access_token)
            .send()
            .await?;

        let data: ZaloApiResponse<UserProfile> = response.json().await?;

        if data.error != 0 {
            return Err(ZaloError::UserNotFound(data.message));
        }

        data.data.ok_or_else(|| ZaloError::UserNotFound("No user data returned".to_string()))
    }

    /// Refresh the access token.
    pub async fn refresh_token(
        app_id: &str,
        secret_key: &str,
        refresh_token: &str,
    ) -> Result<TokenRefreshResponse> {
        let url = format!("{}/oa/access_token", ZALO_OAUTH_API_BASE);

        let client = Client::new();
        let response = client
            .post(&url)
            .header("secret_key", secret_key)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .form(&[
                ("app_id", app_id),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
            ])
            .send()
            .await?;

        let data: TokenRefreshApiResponse = response.json().await?;

        if let Some(error) = data.error {
            return Err(ZaloError::TokenRefreshFailed(
                data.error_description.unwrap_or_else(|| format!("Error code: {}", error)),
            ));
        }

        Ok(TokenRefreshResponse {
            access_token: data.access_token.ok_or_else(|| {
                ZaloError::TokenRefreshFailed("No access token returned".to_string())
            })?,
            refresh_token: data.refresh_token.ok_or_else(|| {
                ZaloError::TokenRefreshFailed("No refresh token returned".to_string())
            })?,
            expires_in: data.expires_in.unwrap_or(3600),
        })
    }
}

// Internal request/response types

#[derive(Debug, Serialize)]
struct Recipient {
    user_id: String,
}

#[derive(Debug, Serialize)]
struct TextMessage {
    text: String,
}

#[derive(Debug, Serialize)]
struct MessageRequest {
    recipient: Recipient,
    message: TextMessage,
}

#[derive(Debug, Serialize)]
struct ImageElement {
    media_type: String,
    url: String,
}

#[derive(Debug, Serialize)]
struct ImagePayload {
    template_type: String,
    elements: Vec<ImageElement>,
}

#[derive(Debug, Serialize)]
struct ImageAttachment {
    #[serde(rename = "type")]
    attachment_type: String,
    payload: ImagePayload,
}

#[derive(Debug, Serialize)]
struct ImageMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    attachment: ImageAttachment,
}

#[derive(Debug, Serialize)]
struct ImageMessageRequest {
    recipient: Recipient,
    message: ImageMessage,
}

#[derive(Debug, Deserialize)]
struct MessageResponse {
    message_id: String,
}

#[derive(Debug, Deserialize)]
struct OAInfoResponse {
    oa_id: String,
    name: String,
    description: Option<String>,
    avatar: Option<String>,
    cover: Option<String>,
}

/// User profile information.
#[derive(Debug, Clone, Deserialize)]
pub struct UserProfile {
    /// User ID.
    pub user_id: String,
    /// Display name.
    pub display_name: String,
    /// Avatar URL.
    pub avatar: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenRefreshApiResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    error: Option<i32>,
    error_description: Option<String>,
}

/// Token refresh response.
#[derive(Debug, Clone)]
pub struct TokenRefreshResponse {
    /// New access token.
    pub access_token: String,
    /// New refresh token.
    pub refresh_token: String,
    /// Token expiry in seconds.
    pub expires_in: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_creation() {
        let client = ZaloClient::new("test_token".to_string());
        assert_eq!(client.access_token, "test_token");
    }
}
