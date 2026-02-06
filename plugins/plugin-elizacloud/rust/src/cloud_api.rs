//! HTTP client for ElizaCloud API.
//!
//! Typed request methods with automatic auth headers,
//! structured error handling, and WS URL construction.

#![allow(missing_docs)]

use reqwest::Client;
use tracing::debug;

use crate::error::ElizaCloudError;

/// HTTP client for the ElizaCloud REST API.
#[derive(Debug, Clone)]
pub struct CloudApiClient {
    base_url: String,
    api_key: Option<String>,
    client: Client,
}

impl CloudApiClient {
    /// Create a new API client.
    pub fn new(base_url: &str, api_key: Option<&str>) -> Result<Self, ElizaCloudError> {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(ElizaCloudError::Network)?;

        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.map(String::from),
            client,
        })
    }

    pub fn set_api_key(&mut self, key: &str) {
        self.api_key = Some(key.to_string());
    }

    pub fn set_base_url(&mut self, url: &str) {
        self.base_url = url.trim_end_matches('/').to_string();
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn api_key(&self) -> Option<&str> {
        self.api_key.as_deref()
    }

    /// Build a WebSocket URL from the base URL, replacing http(s) with ws(s).
    pub fn build_ws_url(&self, path: &str) -> String {
        let ws_base = if self.base_url.starts_with("https") {
            format!("wss{}", &self.base_url[5..])
        } else if self.base_url.starts_with("http") {
            format!("ws{}", &self.base_url[4..])
        } else {
            self.base_url.clone()
        };
        format!("{}{}", ws_base, path)
    }

    /// Send an authenticated GET request.
    pub async fn get(&self, path: &str) -> Result<serde_json::Value, ElizaCloudError> {
        self.request("GET", path, None, false).await
    }

    /// Send an authenticated POST request.
    pub async fn post(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, ElizaCloudError> {
        self.request("POST", path, Some(body), false).await
    }

    /// Send an authenticated DELETE request.
    pub async fn delete(&self, path: &str) -> Result<serde_json::Value, ElizaCloudError> {
        self.request("DELETE", path, None, false).await
    }

    /// POST without auth header — used for device-auth.
    pub async fn post_unauthenticated(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, ElizaCloudError> {
        self.request("POST", path, Some(body), true).await
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
        skip_auth: bool,
    ) -> Result<serde_json::Value, ElizaCloudError> {
        let url = format!("{}{}", self.base_url, path);
        debug!("[CloudAPI] {} {}", method, url);

        let mut request = match method {
            "GET" => self.client.get(&url),
            "POST" => self.client.post(&url),
            "DELETE" => self.client.delete(&url),
            _ => return Err(ElizaCloudError::invalid_request(
                format!("Unsupported HTTP method: {}", method),
                vec![],
            )),
        };

        request = request.header("Content-Type", "application/json");
        request = request.header("Accept", "application/json");

        if !skip_auth {
            if let Some(ref key) = self.api_key {
                request = request.header("Authorization", format!("Bearer {}", key));
            }
        }

        if let Some(body) = body {
            request = request.json(body);
        }

        let response = request.send().await?;
        self.handle_response(response).await
    }

    async fn handle_response(
        &self,
        response: reqwest::Response,
    ) -> Result<serde_json::Value, ElizaCloudError> {
        let status = response.status();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        if !content_type.contains("application/json") {
            if !status.is_success() {
                return Err(ElizaCloudError::Api {
                    status: status.as_u16(),
                    message: format!("HTTP {}: {}", status.as_u16(), status.canonical_reason().unwrap_or("Unknown")),
                    body: None,
                });
            }
            return Ok(serde_json::json!({"success": true}));
        }

        let body_text = response.text().await?;
        let body: serde_json::Value = serde_json::from_str(&body_text).map_err(ElizaCloudError::Json)?;

        if !status.is_success() {
            let error_str = body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string();

            if status.as_u16() == 402 {
                return Err(ElizaCloudError::Api {
                    status: 402,
                    message: format!("Insufficient credits: {}", error_str),
                    body: Some(body_text),
                });
            }

            return Err(ElizaCloudError::Api {
                status: status.as_u16(),
                message: error_str,
                body: Some(body_text),
            });
        }

        Ok(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_creation() {
        let client = CloudApiClient::new("https://api.example.com/v1", Some("test-key"));
        assert!(client.is_ok());
        let client = client.unwrap();
        assert_eq!(client.base_url(), "https://api.example.com/v1");
        assert_eq!(client.api_key(), Some("test-key"));
    }

    #[test]
    fn test_trailing_slash_stripped() {
        let client = CloudApiClient::new("https://api.example.com/v1/", None).unwrap();
        assert_eq!(client.base_url(), "https://api.example.com/v1");
    }

    #[test]
    fn test_build_ws_url_https() {
        let client = CloudApiClient::new("https://api.example.com/v1", None).unwrap();
        assert_eq!(
            client.build_ws_url("/bridge"),
            "wss://api.example.com/v1/bridge"
        );
    }

    #[test]
    fn test_build_ws_url_http() {
        let client = CloudApiClient::new("http://localhost:3000", None).unwrap();
        assert_eq!(client.build_ws_url("/ws"), "ws://localhost:3000/ws");
    }

    #[test]
    fn test_set_api_key() {
        let mut client = CloudApiClient::new("https://api.example.com", None).unwrap();
        assert!(client.api_key().is_none());
        client.set_api_key("new-key");
        assert_eq!(client.api_key(), Some("new-key"));
    }

    #[test]
    fn test_set_base_url() {
        let mut client = CloudApiClient::new("https://old.example.com", None).unwrap();
        client.set_base_url("https://new.example.com/v2/");
        assert_eq!(client.base_url(), "https://new.example.com/v2");
    }
}
