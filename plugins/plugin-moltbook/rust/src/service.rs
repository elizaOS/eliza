#![allow(missing_docs)]

use reqwest::Client;
use serde_json::json;
use tracing::info;

use crate::constants::{content_limits, urls, MOLTBOOK_SERVICE_NAME};
use crate::error::{MoltbookError, Result};
use crate::types::*;

/// MoltbookService - Social engagement service for the Moltbook platform.
/// Enables agents to post, browse, and comment on Moltbook (Reddit for AI agents).
pub struct MoltbookService {
    config: MoltbookConfig,
    client: Client,
    autonomy_running: bool,
}

impl MoltbookService {
    /// Service type identifier
    pub const SERVICE_TYPE: &'static str = MOLTBOOK_SERVICE_NAME;

    /// Create a new MoltbookService with the given configuration
    pub fn new(config: MoltbookConfig) -> Result<Self> {
        if config.agent_name.trim().is_empty() {
            return Err(MoltbookError::Configuration(
                "Agent name cannot be empty".to_string(),
            ));
        }

        let client = Client::new();

        Ok(Self {
            config,
            client,
            autonomy_running: false,
        })
    }

    /// Start the service with the given configuration
    pub async fn start(config: MoltbookConfig) -> Result<Self> {
        let service = Self::new(config)?;

        info!(
            "Moltbook service started for {}",
            service.config.agent_name
        );
        info!("Moltbook API: {}", urls::MOLTBOOK);
        info!(
            "Token configured: {}",
            if service.config.moltbook_token.is_some() {
                "yes"
            } else {
                "no"
            }
        );

        Ok(service)
    }

    /// Stop the service
    pub async fn stop(&mut self) {
        self.autonomy_running = false;
        info!("Moltbook service stopped");
    }

    /// Get the service configuration
    pub fn config(&self) -> &MoltbookConfig {
        &self.config
    }

    /// Check if autonomy loop is running
    pub fn is_autonomy_running(&self) -> bool {
        self.autonomy_running
    }

    /// Build authorization headers (used for testing and external consumers)
    #[allow(dead_code)]
    pub fn auth_headers(&self) -> Vec<(&str, String)> {
        let mut headers = vec![("Content-Type", "application/json".to_string())];
        if let Some(token) = &self.config.moltbook_token {
            headers.push(("Authorization", format!("Bearer {}", token)));
        }
        headers
    }

    /// Build a request with optional auth
    fn build_get_request(&self, url: &str) -> reqwest::RequestBuilder {
        let mut req = self.client.get(url).header("Content-Type", "application/json");
        if let Some(token) = &self.config.moltbook_token {
            req = req.header("Authorization", format!("Bearer {}", token));
        }
        req
    }

    /// Build an authenticated POST request (requires token)
    fn build_auth_post_request(&self, url: &str) -> Result<reqwest::RequestBuilder> {
        let token = self
            .config
            .moltbook_token
            .as_ref()
            .ok_or_else(|| MoltbookError::Authentication("MOLTBOOK_TOKEN not set".to_string()))?;

        Ok(self
            .client
            .post(url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json"))
    }

    /// Post to Moltbook
    pub async fn moltbook_post(
        &self,
        submolt: &str,
        title: &str,
        content: &str,
    ) -> Result<String> {
        if self.config.moltbook_token.is_none() {
            return Err(MoltbookError::Authentication(
                "MOLTBOOK_TOKEN not set - cannot create posts".to_string(),
            ));
        }

        if title.len() > content_limits::MAX_TITLE_LENGTH {
            return Err(MoltbookError::ContentTooLong(format!(
                "Title exceeds maximum length of {} characters",
                content_limits::MAX_TITLE_LENGTH
            )));
        }

        if content.len() > content_limits::MAX_CONTENT_LENGTH {
            return Err(MoltbookError::ContentTooLong(format!(
                "Content exceeds maximum length of {} characters",
                content_limits::MAX_CONTENT_LENGTH
            )));
        }

        let url = format!("{}/posts", urls::MOLTBOOK);
        let req = self.build_auth_post_request(&url)?;

        let response = req
            .json(&json!({
                "submolt": submolt,
                "title": title,
                "content": content,
            }))
            .send()
            .await?;

        let status = response.status();
        let data: serde_json::Value = response.json().await?;

        if !status.is_success() {
            let error_msg = data
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("Unknown error");
            return Err(MoltbookError::Api {
                status: status.as_u16(),
                message: error_msg.to_string(),
            });
        }

        let post_id = data
            .get("post")
            .and_then(|p| p.get("id"))
            .and_then(|id| id.as_str())
            .unwrap_or("success");

        info!("Posted to Moltbook: {} in r/{}", title, submolt);
        Ok(post_id.to_string())
    }

    /// Browse Moltbook posts.
    /// Returns a MoltbookResult so callers can distinguish "no posts" from "API error".
    pub async fn moltbook_browse(
        &self,
        submolt: Option<&str>,
        sort: &str,
    ) -> MoltbookResult<Vec<MoltbookPost>> {
        let url = match submolt {
            Some(s) => format!(
                "{}/submolts/{}/feed?sort={}&limit={}",
                urls::MOLTBOOK,
                s,
                sort,
                content_limits::DEFAULT_BROWSE_LIMIT
            ),
            None => format!(
                "{}/posts?sort={}&limit={}",
                urls::MOLTBOOK,
                sort,
                content_limits::DEFAULT_BROWSE_LIMIT
            ),
        };

        let response = match self.build_get_request(&url).send().await {
            Ok(resp) => resp,
            Err(e) => return moltbook_failure(e.to_string()),
        };

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let error_text = response.text().await.unwrap_or_default();
            return moltbook_failure(format!(
                "API returned {}: {}",
                status,
                &error_text[..error_text.len().min(100)]
            ));
        }

        let data: serde_json::Value = match response.json().await {
            Ok(d) => d,
            Err(e) => return moltbook_failure(e.to_string()),
        };

        let posts: Vec<MoltbookPost> = data
            .get("posts")
            .cloned()
            .and_then(|p| serde_json::from_value(p).ok())
            .unwrap_or_default();

        moltbook_success(posts)
    }

    /// Comment on a Moltbook post
    pub async fn moltbook_comment(&self, post_id: &str, content: &str) -> Result<String> {
        if self.config.moltbook_token.is_none() {
            return Err(MoltbookError::Authentication(
                "MOLTBOOK_TOKEN not set - cannot create comments".to_string(),
            ));
        }

        if content.len() > content_limits::MAX_COMMENT_LENGTH {
            return Err(MoltbookError::ContentTooLong(format!(
                "Comment exceeds maximum length of {} characters",
                content_limits::MAX_COMMENT_LENGTH
            )));
        }

        let url = format!("{}/posts/{}/comments", urls::MOLTBOOK, post_id);
        let req = self.build_auth_post_request(&url)?;

        let response = req.json(&json!({ "content": content })).send().await?;

        let status = response.status();
        let data: serde_json::Value = response.json().await?;

        if !status.is_success() {
            let error_msg = data
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("Unknown error");
            return Err(MoltbookError::Api {
                status: status.as_u16(),
                message: error_msg.to_string(),
            });
        }

        let comment_id = data
            .get("id")
            .and_then(|id| id.as_str())
            .unwrap_or("success");

        info!("Commented on Moltbook post {}", post_id);
        Ok(comment_id.to_string())
    }

    /// Reply to a Moltbook comment
    pub async fn moltbook_reply(
        &self,
        post_id: &str,
        parent_id: &str,
        content: &str,
    ) -> Result<String> {
        if self.config.moltbook_token.is_none() {
            return Err(MoltbookError::Authentication(
                "MOLTBOOK_TOKEN not set - cannot create replies".to_string(),
            ));
        }

        if content.len() > content_limits::MAX_COMMENT_LENGTH {
            return Err(MoltbookError::ContentTooLong(format!(
                "Reply exceeds maximum length of {} characters",
                content_limits::MAX_COMMENT_LENGTH
            )));
        }

        let url = format!("{}/posts/{}/comments", urls::MOLTBOOK, post_id);
        let req = self.build_auth_post_request(&url)?;

        let response = req
            .json(&json!({
                "content": content,
                "parent_id": parent_id,
            }))
            .send()
            .await?;

        let status = response.status();
        let data: serde_json::Value = response.json().await?;

        if !status.is_success() {
            let error_msg = data
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("Unknown error");
            return Err(MoltbookError::Api {
                status: status.as_u16(),
                message: error_msg.to_string(),
            });
        }

        let comment_id = data
            .get("id")
            .and_then(|id| id.as_str())
            .unwrap_or("success");

        info!("Replied to comment {} on post {}", parent_id, post_id);
        Ok(comment_id.to_string())
    }

    /// Read a Moltbook post with comments
    pub async fn moltbook_read_post(&self, post_id: &str) -> Result<PostWithComments> {
        let url = format!("{}/posts/{}", urls::MOLTBOOK, post_id);
        let response = self.build_get_request(&url).send().await?;

        let status = response.status();
        let data: serde_json::Value = response.json().await?;

        if !status.is_success() {
            let error_msg = data
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("Unknown error");
            return Err(MoltbookError::Api {
                status: status.as_u16(),
                message: error_msg.to_string(),
            });
        }

        let post: MoltbookPost = data
            .get("post")
            .cloned()
            .ok_or_else(|| MoltbookError::NotFound("Post not found".to_string()))
            .and_then(|p| serde_json::from_value(p).map_err(MoltbookError::Json))?;

        let comments: Vec<MoltbookComment> = data
            .get("comments")
            .cloned()
            .and_then(|c| serde_json::from_value(c).ok())
            .unwrap_or_default();

        Ok(PostWithComments { post, comments })
    }

    /// List available submolts.
    /// Returns a MoltbookResult so callers can distinguish "no submolts" from "API error".
    pub async fn moltbook_list_submolts(&self, sort: &str) -> MoltbookResult<Vec<MoltbookSubmolt>> {
        let url = format!("{}/submolts?sort={}&limit=20", urls::MOLTBOOK, sort);

        let response = match self.build_get_request(&url).send().await {
            Ok(resp) => resp,
            Err(e) => return moltbook_failure(e.to_string()),
        };

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let error_text = response.text().await.unwrap_or_default();
            return moltbook_failure(format!(
                "API returned {}: {}",
                status,
                &error_text[..error_text.len().min(100)]
            ));
        }

        let data: serde_json::Value = match response.json().await {
            Ok(d) => d,
            Err(e) => return moltbook_failure(e.to_string()),
        };

        let submolts: Vec<MoltbookSubmolt> = data
            .get("submolts")
            .cloned()
            .and_then(|s| serde_json::from_value(s).ok())
            .unwrap_or_default();

        moltbook_success(submolts)
    }

    /// Get details about a specific submolt.
    /// Returns a MoltbookResult so callers can distinguish "not found" from "API error".
    pub async fn moltbook_get_submolt(
        &self,
        submolt_name: &str,
    ) -> MoltbookResult<Option<MoltbookSubmolt>> {
        let url = format!("{}/submolts/{}", urls::MOLTBOOK, submolt_name);

        let response = match self.build_get_request(&url).send().await {
            Ok(resp) => resp,
            Err(e) => return moltbook_failure(e.to_string()),
        };

        if response.status().as_u16() == 404 {
            // Not found is a valid result, not an error
            return moltbook_success(None);
        }

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let error_text = response.text().await.unwrap_or_default();
            return moltbook_failure(format!(
                "API returned {}: {}",
                status,
                &error_text[..error_text.len().min(100)]
            ));
        }

        let data: serde_json::Value = match response.json().await {
            Ok(d) => d,
            Err(e) => return moltbook_failure(e.to_string()),
        };

        let submolt: Option<MoltbookSubmolt> = data
            .get("submolt")
            .cloned()
            .and_then(|s| serde_json::from_value(s).ok());

        moltbook_success(submolt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_without_agent_name() {
        let config = MoltbookConfig {
            agent_name: String::new(),
            moltbook_token: None,
            autonomous_mode: false,
            autonomy_interval_ms: None,
            autonomy_max_steps: None,
        };

        let result = MoltbookService::new(config);
        assert!(result.is_err());
    }

    #[test]
    fn test_new_with_config() {
        let config = MoltbookConfig {
            agent_name: "TestAgent".to_string(),
            moltbook_token: Some("test-token".to_string()),
            autonomous_mode: false,
            autonomy_interval_ms: None,
            autonomy_max_steps: None,
        };

        let result = MoltbookService::new(config);
        assert!(result.is_ok());
        let service = result.unwrap();
        assert_eq!(service.config().agent_name, "TestAgent");
        assert!(!service.is_autonomy_running());
    }

    #[test]
    fn test_new_without_token() {
        let config = MoltbookConfig {
            agent_name: "TestAgent".to_string(),
            moltbook_token: None,
            autonomous_mode: false,
            autonomy_interval_ms: None,
            autonomy_max_steps: None,
        };

        let service = MoltbookService::new(config).unwrap();
        assert!(service.config().moltbook_token.is_none());
    }

    #[test]
    fn test_auth_headers_with_token() {
        let config = MoltbookConfig {
            agent_name: "TestAgent".to_string(),
            moltbook_token: Some("my-token".to_string()),
            autonomous_mode: false,
            autonomy_interval_ms: None,
            autonomy_max_steps: None,
        };

        let service = MoltbookService::new(config).unwrap();
        let headers = service.auth_headers();
        assert_eq!(headers.len(), 2);
        assert_eq!(headers[1].0, "Authorization");
        assert_eq!(headers[1].1, "Bearer my-token");
    }

    #[test]
    fn test_auth_headers_without_token() {
        let config = MoltbookConfig {
            agent_name: "TestAgent".to_string(),
            moltbook_token: None,
            autonomous_mode: false,
            autonomy_interval_ms: None,
            autonomy_max_steps: None,
        };

        let service = MoltbookService::new(config).unwrap();
        let headers = service.auth_headers();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].0, "Content-Type");
    }
}
