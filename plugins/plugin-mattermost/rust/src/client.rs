use reqwest::{Client, Response};
use serde::de::DeserializeOwned;

use crate::error::{MattermostError, Result};
use crate::types::{MattermostChannel, MattermostFileInfo, MattermostPost, MattermostUser};

/// Mattermost API client.
#[derive(Clone)]
pub struct MattermostClient {
    base_url: String,
    api_base_url: String,
    token: String,
    http_client: Client,
}

impl MattermostClient {
    /// Creates a new Mattermost client.
    pub fn new(base_url: &str, bot_token: &str) -> Result<Self> {
        let normalized = normalize_base_url(base_url);
        if normalized.is_empty() {
            return Err(MattermostError::ConfigError(
                "Mattermost baseUrl is required".to_string(),
            ));
        }

        let api_base_url = format!("{}/api/v4", normalized);
        let token = bot_token.trim().to_string();

        let http_client = Client::builder()
            .build()
            .map_err(|e| MattermostError::Internal(e.to_string()))?;

        Ok(Self {
            base_url: normalized,
            api_base_url,
            token,
            http_client,
        })
    }

    /// Returns the base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Returns the API base URL.
    pub fn api_base_url(&self) -> &str {
        &self.api_base_url
    }

    /// Returns the token.
    pub fn token(&self) -> &str {
        &self.token
    }

    /// Makes an authenticated GET request.
    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let url = self.build_url(path);
        let response = self
            .http_client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .send()
            .await?;

        self.handle_response(response).await
    }

    /// Makes an authenticated POST request with JSON body.
    pub async fn post<T: DeserializeOwned, B: serde::Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T> {
        let url = self.build_url(path);
        let response = self
            .http_client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .json(body)
            .send()
            .await?;

        self.handle_response(response).await
    }

    /// Makes an authenticated PUT request with JSON body.
    pub async fn put<T: DeserializeOwned, B: serde::Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T> {
        let url = self.build_url(path);
        let response = self
            .http_client
            .put(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .json(body)
            .send()
            .await?;

        self.handle_response(response).await
    }

    /// Makes an authenticated DELETE request.
    pub async fn delete(&self, path: &str) -> Result<()> {
        let url = self.build_url(path);
        let response = self
            .http_client
            .delete(&url)
            .header("Authorization", format!("Bearer {}", self.token))
            .send()
            .await?;

        if !response.status().is_success() {
            let error = self.read_error(response).await;
            return Err(MattermostError::ApiError(error));
        }

        Ok(())
    }

    fn build_url(&self, path: &str) -> String {
        let suffix = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{}", path)
        };
        format!("{}{}", self.api_base_url, suffix)
    }

    async fn handle_response<T: DeserializeOwned>(&self, response: Response) -> Result<T> {
        if !response.status().is_success() {
            let error = self.read_error(response).await;
            return Err(MattermostError::ApiError(error));
        }

        response
            .json()
            .await
            .map_err(|e| MattermostError::SerializationError(e.to_string()))
    }

    async fn read_error(&self, response: Response) -> String {
        let status = response.status();
        match response.json::<serde_json::Value>().await {
            Ok(json) => {
                if let Some(message) = json.get("message").and_then(|m| m.as_str()) {
                    return message.to_string();
                }
                if let Some(detailed) = json.get("detailed_error").and_then(|m| m.as_str()) {
                    return detailed.to_string();
                }
                json.to_string()
            }
            Err(_) => format!("HTTP {}", status),
        }
    }

    // === User API ===

    /// Fetches the authenticated user's information.
    pub async fn get_me(&self) -> Result<MattermostUser> {
        self.get("/users/me").await
    }

    /// Fetches a user by their ID.
    pub async fn get_user(&self, user_id: &str) -> Result<MattermostUser> {
        self.get(&format!("/users/{}", user_id)).await
    }

    /// Fetches a user by their username.
    pub async fn get_user_by_username(&self, username: &str) -> Result<MattermostUser> {
        self.get(&format!(
            "/users/username/{}",
            urlencoding::encode(username)
        ))
        .await
    }

    /// Fetches multiple users by their IDs.
    pub async fn get_users_by_ids(&self, user_ids: &[String]) -> Result<Vec<MattermostUser>> {
        self.post("/users/ids", &user_ids).await
    }

    // === Channel API ===

    /// Fetches a channel by its ID.
    pub async fn get_channel(&self, channel_id: &str) -> Result<MattermostChannel> {
        self.get(&format!("/channels/{}", channel_id)).await
    }

    /// Creates a direct message channel between users.
    pub async fn create_direct_channel(&self, user_ids: &[String]) -> Result<MattermostChannel> {
        self.post("/channels/direct", &user_ids).await
    }

    /// Creates a group message channel between users.
    pub async fn create_group_channel(&self, user_ids: &[String]) -> Result<MattermostChannel> {
        self.post("/channels/group", &user_ids).await
    }

    // === Post API ===

    /// Creates a post (message) in a channel.
    pub async fn create_post(&self, params: CreatePostParams<'_>) -> Result<MattermostPost> {
        #[derive(serde::Serialize)]
        struct PostBody<'a> {
            channel_id: &'a str,
            message: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            root_id: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            file_ids: Option<&'a [String]>,
            #[serde(skip_serializing_if = "Option::is_none")]
            props: Option<&'a serde_json::Value>,
        }

        let body = PostBody {
            channel_id: params.channel_id,
            message: params.message,
            root_id: params.root_id,
            file_ids: params.file_ids,
            props: params.props,
        };

        self.post("/posts", &body).await
    }

    /// Updates a post.
    pub async fn update_post(&self, post_id: &str, message: &str) -> Result<MattermostPost> {
        #[derive(serde::Serialize)]
        struct UpdateBody<'a> {
            message: &'a str,
        }

        self.put(&format!("/posts/{}", post_id), &UpdateBody { message })
            .await
    }

    /// Deletes a post.
    pub async fn delete_post(&self, post_id: &str) -> Result<()> {
        self.delete(&format!("/posts/{}", post_id)).await
    }

    /// Gets a post by its ID.
    pub async fn get_post(&self, post_id: &str) -> Result<MattermostPost> {
        self.get(&format!("/posts/{}", post_id)).await
    }

    /// Gets a post thread.
    pub async fn get_post_thread(&self, post_id: &str) -> Result<PostThreadResponse> {
        self.get(&format!("/posts/{}/thread", post_id)).await
    }

    // === Typing API ===

    /// Sends a typing indicator.
    pub async fn send_typing(&self, channel_id: &str, parent_id: Option<&str>) -> Result<()> {
        #[derive(serde::Serialize)]
        struct TypingBody<'a> {
            channel_id: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            parent_id: Option<&'a str>,
        }

        let body = TypingBody {
            channel_id,
            parent_id,
        };

        let _: serde_json::Value = self.post("/users/me/typing", &body).await?;
        Ok(())
    }

    // === File API ===

    /// Gets file info by ID.
    pub async fn get_file_info(&self, file_id: &str) -> Result<MattermostFileInfo> {
        self.get(&format!("/files/{}/info", file_id)).await
    }

    /// Returns the WebSocket URL for real-time events.
    pub fn websocket_url(&self) -> String {
        let ws_base = self.base_url.replace("http://", "ws://").replace("https://", "wss://");
        format!("{}/api/v4/websocket", ws_base)
    }
}

/// Parameters for creating a post.
pub struct CreatePostParams<'a> {
    /// Channel ID.
    pub channel_id: &'a str,
    /// Message content.
    pub message: &'a str,
    /// Root post ID for threading.
    pub root_id: Option<&'a str>,
    /// File attachment IDs.
    pub file_ids: Option<&'a [String]>,
    /// Post properties.
    pub props: Option<&'a serde_json::Value>,
}

/// Response for getting a post thread.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PostThreadResponse {
    /// Post IDs in order.
    pub order: Vec<String>,
    /// Posts by ID.
    pub posts: std::collections::HashMap<String, MattermostPost>,
}

/// Normalizes the base URL by removing trailing slashes and /api/v4 suffix.
fn normalize_base_url(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut normalized = trimmed.trim_end_matches('/').to_string();
    if normalized.to_lowercase().ends_with("/api/v4") {
        normalized = normalized[..normalized.len() - 7].to_string();
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_base_url() {
        assert_eq!(
            normalize_base_url("https://chat.example.com/"),
            "https://chat.example.com"
        );
        assert_eq!(
            normalize_base_url("https://chat.example.com/api/v4"),
            "https://chat.example.com"
        );
        assert_eq!(
            normalize_base_url("https://chat.example.com/api/v4/"),
            "https://chat.example.com"
        );
        assert_eq!(normalize_base_url(""), "");
    }

    #[test]
    fn test_client_creation() {
        let client = MattermostClient::new("https://chat.example.com", "bot_token").unwrap();
        assert_eq!(client.base_url(), "https://chat.example.com");
        assert_eq!(client.api_base_url(), "https://chat.example.com/api/v4");
    }

    #[test]
    fn test_client_websocket_url() {
        let client = MattermostClient::new("https://chat.example.com", "bot_token").unwrap();
        assert_eq!(
            client.websocket_url(),
            "wss://chat.example.com/api/v4/websocket"
        );
    }
}
