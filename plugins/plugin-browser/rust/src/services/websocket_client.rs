use crate::types::{NavigationResult, WebSocketMessage, WebSocketResponse};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, error, info};
use uuid::Uuid;

type ResponseSender = mpsc::Sender<WebSocketResponse>;
type ResponseMap = Arc<RwLock<HashMap<String, ResponseSender>>>;

pub struct BrowserWebSocketClient {
    server_url: String,
    connected: Arc<RwLock<bool>>,
    pending_requests: ResponseMap,
    sender: Arc<RwLock<Option<mpsc::Sender<Message>>>>,
}

impl BrowserWebSocketClient {
    pub fn new(server_url: &str) -> Self {
        Self {
            server_url: server_url.to_string(),
            connected: Arc::new(RwLock::new(false)),
            pending_requests: Arc::new(RwLock::new(HashMap::new())),
            sender: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn connect(&self) -> Result<(), String> {
        let url = url::Url::parse(&self.server_url).map_err(|e| format!("Invalid URL: {}", e))?;

        let (ws_stream, _) = connect_async(url)
            .await
            .map_err(|e| format!("Connection failed: {}", e))?;

        let (mut write, mut read) = ws_stream.split();

        let (tx, mut rx) = mpsc::channel::<Message>(100);
        *self.sender.write().await = Some(tx);
        *self.connected.write().await = true;

        info!("[Browser] Connected to server at {}", self.server_url);

        let pending = Arc::clone(&self.pending_requests);
        let connected = Arc::clone(&self.connected);

        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(response) = serde_json::from_str::<WebSocketResponse>(&text) {
                            let requests = pending.read().await;
                            if let Some(sender) = requests.get(&response.request_id) {
                                let _ = sender.send(response).await;
                            }
                        }
                    }
                    Ok(Message::Close(_)) => {
                        info!("[Browser] Connection closed");
                        *connected.write().await = false;
                        break;
                    }
                    Err(e) => {
                        error!("[Browser] Error receiving message: {}", e);
                    }
                    _ => {}
                }
            }
        });

        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if let Err(e) = write.send(msg).await {
                    error!("[Browser] Error sending message: {}", e);
                    break;
                }
            }
        });

        Ok(())
    }

    pub async fn send_message(
        &self,
        msg_type: &str,
        data: HashMap<String, serde_json::Value>,
    ) -> Result<WebSocketResponse, String> {
        if !*self.connected.read().await {
            return Err("Not connected to browser server".to_string());
        }

        let request_id = Uuid::new_v4().to_string();
        let mut message_data = data;

        let message = WebSocketMessage {
            msg_type: msg_type.to_string(),
            request_id: request_id.clone(),
            session_id: message_data
                .remove("sessionId")
                .and_then(|v| v.as_str().map(|s| s.to_string())),
            data: if message_data.is_empty() {
                None
            } else {
                Some(message_data)
            },
        };

        let json = serde_json::to_string(&message)
            .map_err(|e| format!("Failed to serialize message: {}", e))?;

        let (tx, mut rx) = mpsc::channel::<WebSocketResponse>(1);
        self.pending_requests
            .write()
            .await
            .insert(request_id.clone(), tx);

        if let Some(sender) = self.sender.read().await.as_ref() {
            sender
                .send(Message::Text(json))
                .await
                .map_err(|e| format!("Failed to send message: {}", e))?;
        }

        debug!("[Browser] Sent message: {} ({})", msg_type, request_id);

        let response = tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv())
            .await
            .map_err(|_| format!("Request timeout for {}", msg_type))?
            .ok_or_else(|| "No response received".to_string())?;

        self.pending_requests.write().await.remove(&request_id);

        if response.msg_type == "error" {
            return Err(response
                .error
                .unwrap_or_else(|| "Unknown error".to_string()));
        }

        Ok(response)
    }

    pub async fn disconnect(&self) {
        *self.connected.write().await = false;
        *self.sender.write().await = None;
        info!("[Browser] Client disconnected");
    }

    pub async fn is_connected(&self) -> bool {
        *self.connected.read().await
    }

    pub async fn navigate(&self, session_id: &str, url: &str) -> Result<NavigationResult, String> {
        let mut data = HashMap::new();
        data.insert("sessionId".to_string(), serde_json::json!(session_id));

        let mut inner_data = HashMap::new();
        inner_data.insert("url".to_string(), serde_json::json!(url));
        data.insert("data".to_string(), serde_json::json!(inner_data));

        let response = self.send_message("navigate", data).await?;

        let resp_data = response.data.unwrap_or_default();
        Ok(NavigationResult {
            success: response.success,
            url: resp_data
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or(url)
                .to_string(),
            title: resp_data
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            error: response.error,
        })
    }

    pub async fn get_state(
        &self,
        session_id: &str,
    ) -> Result<HashMap<String, serde_json::Value>, String> {
        let mut data = HashMap::new();
        data.insert("sessionId".to_string(), serde_json::json!(session_id));

        let response = self.send_message("getState", data).await?;
        Ok(response.data.unwrap_or_default())
    }

    pub async fn go_back(&self, session_id: &str) -> Result<NavigationResult, String> {
        let mut data = HashMap::new();
        data.insert("sessionId".to_string(), serde_json::json!(session_id));

        let response = self.send_message("goBack", data).await?;
        let resp_data = response.data.unwrap_or_default();

        Ok(NavigationResult {
            success: response.success,
            url: resp_data
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            title: resp_data
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            error: response.error,
        })
    }

    pub async fn go_forward(&self, session_id: &str) -> Result<NavigationResult, String> {
        let mut data = HashMap::new();
        data.insert("sessionId".to_string(), serde_json::json!(session_id));

        let response = self.send_message("goForward", data).await?;
        let resp_data = response.data.unwrap_or_default();

        Ok(NavigationResult {
            success: response.success,
            url: resp_data
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            title: resp_data
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            error: response.error,
        })
    }

    pub async fn refresh(&self, session_id: &str) -> Result<NavigationResult, String> {
        let mut data = HashMap::new();
        data.insert("sessionId".to_string(), serde_json::json!(session_id));

        let response = self.send_message("refresh", data).await?;
        let resp_data = response.data.unwrap_or_default();

        Ok(NavigationResult {
            success: response.success,
            url: resp_data
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            title: resp_data
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            error: response.error,
        })
    }

    pub async fn click(
        &self,
        session_id: &str,
        description: &str,
    ) -> Result<WebSocketResponse, String> {
        let mut data = HashMap::new();
        data.insert("sessionId".to_string(), serde_json::json!(session_id));

        let mut inner_data = HashMap::new();
        inner_data.insert("description".to_string(), serde_json::json!(description));
        data.insert("data".to_string(), serde_json::json!(inner_data));

        self.send_message("click", data).await
    }

    pub async fn type_text(
        &self,
        session_id: &str,
        text: &str,
        field: &str,
    ) -> Result<WebSocketResponse, String> {
        let mut data = HashMap::new();
        data.insert("sessionId".to_string(), serde_json::json!(session_id));

        let mut inner_data = HashMap::new();
        inner_data.insert("text".to_string(), serde_json::json!(text));
        inner_data.insert("field".to_string(), serde_json::json!(field));
        data.insert("data".to_string(), serde_json::json!(inner_data));

        self.send_message("type", data).await
    }

    pub async fn select(
        &self,
        session_id: &str,
        option: &str,
        dropdown: &str,
    ) -> Result<WebSocketResponse, String> {
        let mut data = HashMap::new();
        data.insert("sessionId".to_string(), serde_json::json!(session_id));

        let mut inner_data = HashMap::new();
        inner_data.insert("option".to_string(), serde_json::json!(option));
        inner_data.insert("dropdown".to_string(), serde_json::json!(dropdown));
        data.insert("data".to_string(), serde_json::json!(inner_data));

        self.send_message("select", data).await
    }

    pub async fn extract(
        &self,
        session_id: &str,
        instruction: &str,
    ) -> Result<WebSocketResponse, String> {
        let mut data = HashMap::new();
        data.insert("sessionId".to_string(), serde_json::json!(session_id));

        let mut inner_data = HashMap::new();
        inner_data.insert("instruction".to_string(), serde_json::json!(instruction));
        data.insert("data".to_string(), serde_json::json!(inner_data));

        self.send_message("extract", data).await
    }

    pub async fn screenshot(&self, session_id: &str) -> Result<WebSocketResponse, String> {
        let mut data = HashMap::new();
        data.insert("sessionId".to_string(), serde_json::json!(session_id));

        self.send_message("screenshot", data).await
    }

    pub async fn solve_captcha(&self, session_id: &str) -> Result<WebSocketResponse, String> {
        let mut data = HashMap::new();
        data.insert("sessionId".to_string(), serde_json::json!(session_id));

        self.send_message("solveCaptcha", data).await
    }

    pub async fn health(&self) -> Result<bool, String> {
        let response = self.send_message("health", HashMap::new()).await?;

        let is_healthy = response.msg_type == "health"
            && response
                .data
                .as_ref()
                .and_then(|d| d.get("status"))
                .and_then(|v| v.as_str())
                == Some("ok");

        Ok(is_healthy)
    }
}
