//! CapSolver integration for CAPTCHA solving.

use crate::types::CaptchaType;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tokio::time::sleep;
use tracing::info;

/// CapSolver configuration
#[derive(Debug, Clone)]
pub struct CapSolverConfig {
    pub api_key: String,
    pub api_url: String,
    pub retry_attempts: u32,
    pub polling_interval_ms: u64,
}

impl CapSolverConfig {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            api_url: "https://api.capsolver.com".to_string(),
            retry_attempts: 60,
            polling_interval_ms: 2000,
        }
    }
}

#[derive(Serialize)]
struct CreateTaskRequest {
    #[serde(rename = "clientKey")]
    client_key: String,
    task: HashMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct CreateTaskResponse {
    #[serde(rename = "errorId")]
    error_id: i32,
    #[serde(rename = "errorDescription")]
    error_description: Option<String>,
    #[serde(rename = "taskId")]
    task_id: Option<String>,
}

#[derive(Serialize)]
struct GetTaskResultRequest {
    #[serde(rename = "clientKey")]
    client_key: String,
    #[serde(rename = "taskId")]
    task_id: String,
}

#[derive(Deserialize)]
struct GetTaskResultResponse {
    #[serde(rename = "errorId")]
    error_id: i32,
    #[serde(rename = "errorDescription")]
    error_description: Option<String>,
    status: Option<String>,
    solution: Option<HashMap<String, serde_json::Value>>,
}

/// CapSolver service for solving various CAPTCHA types
pub struct CapSolverService {
    config: CapSolverConfig,
    client: Client,
}

impl CapSolverService {
    pub fn new(config: CapSolverConfig) -> Self {
        Self {
            config,
            client: Client::new(),
        }
    }

    /// Create a CAPTCHA solving task
    pub async fn create_task(
        &self,
        task: HashMap<String, serde_json::Value>,
    ) -> Result<String, String> {
        let request = CreateTaskRequest {
            client_key: self.config.api_key.clone(),
            task,
        };

        let response = self
            .client
            .post(format!("{}/createTask", self.config.api_url))
            .json(&request)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        let data: CreateTaskResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        if data.error_id != 0 {
            return Err(format!(
                "CapSolver error: {}",
                data.error_description.unwrap_or_else(|| "Unknown error".to_string())
            ));
        }

        let task_id = data.task_id.ok_or("No task ID returned")?;
        info!("CapSolver task created: {}", task_id);
        Ok(task_id)
    }

    /// Get task result with polling
    pub async fn get_task_result(
        &self,
        task_id: &str,
    ) -> Result<HashMap<String, serde_json::Value>, String> {
        for _ in 0..self.config.retry_attempts {
            let request = GetTaskResultRequest {
                client_key: self.config.api_key.clone(),
                task_id: task_id.to_string(),
            };

            let response = self
                .client
                .post(format!("{}/getTaskResult", self.config.api_url))
                .json(&request)
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("Request failed: {}", e))?;

            let data: GetTaskResultResponse = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {}", e))?;

            if data.error_id != 0 {
                return Err(format!(
                    "CapSolver error: {}",
                    data.error_description.unwrap_or_else(|| "Unknown error".to_string())
                ));
            }

            if data.status.as_deref() == Some("ready") {
                info!("CapSolver task completed successfully");
                return data.solution.ok_or("No solution returned".to_string());
            }

            sleep(Duration::from_millis(self.config.polling_interval_ms)).await;
        }

        Err("CapSolver task timeout".to_string())
    }

    /// Solve Cloudflare Turnstile
    pub async fn solve_turnstile(
        &self,
        website_url: &str,
        website_key: &str,
        proxy: Option<&str>,
        user_agent: Option<&str>,
    ) -> Result<String, String> {
        info!("Solving Cloudflare Turnstile captcha");

        let mut task = HashMap::new();
        task.insert(
            "type".to_string(),
            serde_json::json!(if proxy.is_some() {
                "AntiTurnstileTask"
            } else {
                "AntiTurnstileTaskProxyLess"
            }),
        );
        task.insert("websiteURL".to_string(), serde_json::json!(website_url));
        task.insert("websiteKey".to_string(), serde_json::json!(website_key));

        if let Some(p) = proxy {
            let parts: Vec<&str> = p.split(':').collect();
            task.insert("proxy".to_string(), serde_json::json!(format!("{}:{}", parts[0], parts[1])));
            if parts.len() > 2 {
                task.insert("proxyLogin".to_string(), serde_json::json!(parts[2]));
                task.insert("proxyPassword".to_string(), serde_json::json!(parts[3]));
            }
        }

        if let Some(ua) = user_agent {
            task.insert("userAgent".to_string(), serde_json::json!(ua));
        }

        let task_id = self.create_task(task).await?;
        let solution = self.get_task_result(&task_id).await?;

        solution
            .get("token")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or("No token in solution".to_string())
    }

    /// Solve reCAPTCHA v2
    pub async fn solve_recaptcha_v2(
        &self,
        website_url: &str,
        website_key: &str,
        is_invisible: bool,
        proxy: Option<&str>,
    ) -> Result<String, String> {
        info!("Solving reCAPTCHA v2");

        let mut task = HashMap::new();
        task.insert(
            "type".to_string(),
            serde_json::json!(if proxy.is_some() {
                "RecaptchaV2Task"
            } else {
                "RecaptchaV2TaskProxyless"
            }),
        );
        task.insert("websiteURL".to_string(), serde_json::json!(website_url));
        task.insert("websiteKey".to_string(), serde_json::json!(website_key));
        task.insert("isInvisible".to_string(), serde_json::json!(is_invisible));

        if let Some(p) = proxy {
            let parts: Vec<&str> = p.split(':').collect();
            task.insert("proxy".to_string(), serde_json::json!(format!("{}:{}", parts[0], parts[1])));
            if parts.len() > 2 {
                task.insert("proxyLogin".to_string(), serde_json::json!(parts[2]));
                task.insert("proxyPassword".to_string(), serde_json::json!(parts[3]));
            }
        }

        let task_id = self.create_task(task).await?;
        let solution = self.get_task_result(&task_id).await?;

        solution
            .get("gRecaptchaResponse")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or("No gRecaptchaResponse in solution".to_string())
    }

    /// Solve reCAPTCHA v3
    pub async fn solve_recaptcha_v3(
        &self,
        website_url: &str,
        website_key: &str,
        page_action: &str,
        min_score: f64,
        proxy: Option<&str>,
    ) -> Result<String, String> {
        info!("Solving reCAPTCHA v3");

        let mut task = HashMap::new();
        task.insert(
            "type".to_string(),
            serde_json::json!(if proxy.is_some() {
                "RecaptchaV3Task"
            } else {
                "RecaptchaV3TaskProxyless"
            }),
        );
        task.insert("websiteURL".to_string(), serde_json::json!(website_url));
        task.insert("websiteKey".to_string(), serde_json::json!(website_key));
        task.insert("pageAction".to_string(), serde_json::json!(page_action));
        task.insert("minScore".to_string(), serde_json::json!(min_score));

        if let Some(p) = proxy {
            let parts: Vec<&str> = p.split(':').collect();
            task.insert("proxy".to_string(), serde_json::json!(format!("{}:{}", parts[0], parts[1])));
            if parts.len() > 2 {
                task.insert("proxyLogin".to_string(), serde_json::json!(parts[2]));
                task.insert("proxyPassword".to_string(), serde_json::json!(parts[3]));
            }
        }

        let task_id = self.create_task(task).await?;
        let solution = self.get_task_result(&task_id).await?;

        solution
            .get("gRecaptchaResponse")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or("No gRecaptchaResponse in solution".to_string())
    }

    /// Solve hCaptcha
    pub async fn solve_hcaptcha(
        &self,
        website_url: &str,
        website_key: &str,
        proxy: Option<&str>,
    ) -> Result<String, String> {
        info!("Solving hCaptcha");

        let mut task = HashMap::new();
        task.insert(
            "type".to_string(),
            serde_json::json!(if proxy.is_some() {
                "HCaptchaTask"
            } else {
                "HCaptchaTaskProxyless"
            }),
        );
        task.insert("websiteURL".to_string(), serde_json::json!(website_url));
        task.insert("websiteKey".to_string(), serde_json::json!(website_key));

        if let Some(p) = proxy {
            let parts: Vec<&str> = p.split(':').collect();
            task.insert("proxy".to_string(), serde_json::json!(format!("{}:{}", parts[0], parts[1])));
            if parts.len() > 2 {
                task.insert("proxyLogin".to_string(), serde_json::json!(parts[2]));
                task.insert("proxyPassword".to_string(), serde_json::json!(parts[3]));
            }
        }

        let task_id = self.create_task(task).await?;
        let solution = self.get_task_result(&task_id).await?;

        solution
            .get("token")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or("No token in solution".to_string())
    }
}

/// Detect CAPTCHA type (placeholder - would need actual browser integration)
pub fn detect_captcha_type(_page_content: &str) -> (CaptchaType, Option<String>) {
    // This would need actual browser/page integration to work properly
    // For now, return no captcha detected
    (CaptchaType::None, None)
}

