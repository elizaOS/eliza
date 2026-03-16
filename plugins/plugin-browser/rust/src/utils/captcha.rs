use crate::types::CaptchaType;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tokio::time::sleep;
use tracing::info;

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
                data.error_description
                    .unwrap_or_else(|| "Unknown error".to_string())
            ));
        }

        let task_id = data.task_id.ok_or("No task ID returned")?;
        info!("CapSolver task created: {}", task_id);
        Ok(task_id)
    }

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
                    data.error_description
                        .unwrap_or_else(|| "Unknown error".to_string())
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
            task.insert(
                "proxy".to_string(),
                serde_json::json!(format!("{}:{}", parts[0], parts[1])),
            );
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
            task.insert(
                "proxy".to_string(),
                serde_json::json!(format!("{}:{}", parts[0], parts[1])),
            );
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
            task.insert(
                "proxy".to_string(),
                serde_json::json!(format!("{}:{}", parts[0], parts[1])),
            );
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
            task.insert(
                "proxy".to_string(),
                serde_json::json!(format!("{}:{}", parts[0], parts[1])),
            );
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

pub fn detect_captcha_type(page_content: &str) -> (CaptchaType, Option<String>) {
    // Check for Cloudflare Turnstile
    if page_content.contains("cf-turnstile")
        || page_content.contains("challenges.cloudflare.com/turnstile")
    {
        let site_key = extract_data_sitekey(page_content);
        return (CaptchaType::Turnstile, site_key);
    }

    // Check for hCaptcha (check before reCAPTCHA since hCaptcha also uses g-recaptcha-response)
    if page_content.contains("h-captcha")
        || page_content.contains("hcaptcha.com")
        || page_content.contains("data-hcaptcha-sitekey")
    {
        let site_key = extract_data_sitekey(page_content);
        return (CaptchaType::Hcaptcha, site_key);
    }

    // Check for reCAPTCHA
    if page_content.contains("g-recaptcha") || page_content.contains("google.com/recaptcha") {
        let site_key = extract_data_sitekey(page_content);
        // Check for v3 indicators
        if page_content.contains("grecaptcha.execute")
            || page_content.contains("recaptcha/api.js?render=")
        {
            return (CaptchaType::RecaptchaV3, site_key);
        }
        return (CaptchaType::RecaptchaV2, site_key);
    }

    (CaptchaType::None, None)
}

fn extract_data_sitekey(html: &str) -> Option<String> {
    // Pattern to match data-sitekey="..." or data-sitekey='...'
    let patterns = [
        r#"data-sitekey="([^"]+)""#,
        r#"data-sitekey='([^']+)'"#,
        r#"data-hcaptcha-sitekey="([^"]+)""#,
        r#"data-hcaptcha-sitekey='([^']+)'"#,
    ];

    for pattern in patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(caps) = re.captures(html) {
                if let Some(key) = caps.get(1) {
                    return Some(key.as_str().to_string());
                }
            }
        }
    }
    None
}

pub fn generate_captcha_injection_script(captcha_type: &CaptchaType, solution: &str) -> String {
    let escaped_solution = solution.replace('\\', "\\\\").replace('"', "\\\"");

    match captcha_type {
        CaptchaType::Turnstile => {
            format!(
                r#"(function() {{
                    var textarea = document.querySelector('[name="cf-turnstile-response"]');
                    if (textarea) textarea.value = "{}";
                    if (typeof window.turnstileCallback === 'function') window.turnstileCallback("{}");
                }})()"#,
                escaped_solution, escaped_solution
            )
        }
        CaptchaType::RecaptchaV2 | CaptchaType::RecaptchaV3 => {
            format!(
                r#"(function() {{
                    var textarea = document.querySelector('[name="g-recaptcha-response"]');
                    if (textarea) {{
                        textarea.value = "{}";
                        textarea.style.display = 'block';
                    }}
                    if (typeof window.onRecaptchaSuccess === 'function') window.onRecaptchaSuccess("{}");
                }})()"#,
                escaped_solution, escaped_solution
            )
        }
        CaptchaType::Hcaptcha => {
            format!(
                r#"(function() {{
                    var hcaptcha = document.querySelector('[name="h-captcha-response"]');
                    if (hcaptcha) hcaptcha.value = "{}";
                    var grecaptcha = document.querySelector('[name="g-recaptcha-response"]');
                    if (grecaptcha) grecaptcha.value = "{}";
                    if (typeof window.hcaptchaCallback === 'function') window.hcaptchaCallback("{}");
                }})()"#,
                escaped_solution, escaped_solution, escaped_solution
            )
        }
        CaptchaType::None => String::new(),
    }
}
