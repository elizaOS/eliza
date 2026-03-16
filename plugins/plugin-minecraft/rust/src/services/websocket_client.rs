use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, error, info};
use uuid::Uuid;

type ResponseSender = mpsc::Sender<BridgeResponse>;
type ResponseMap = Arc<RwLock<HashMap<String, ResponseSender>>>;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BridgeRequest {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "botId", skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, Value>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BridgeResponse {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct MinecraftWebSocketClient {
    server_url: String,
    connected: Arc<RwLock<bool>>,
    pending_requests: ResponseMap,
    sender: Arc<RwLock<Option<mpsc::Sender<Message>>>>,
}

impl MinecraftWebSocketClient {
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
        let (ws_stream, _) = connect_async(url.as_str())
            .await
            .map_err(|e| format!("Connection failed: {}", e))?;

        let (mut write, mut read) = ws_stream.split();
        let (tx, mut rx) = mpsc::channel::<Message>(100);
        *self.sender.write().await = Some(tx);
        *self.connected.write().await = true;

        info!("[Minecraft] Connected to server at {}", self.server_url);

        let pending = Arc::clone(&self.pending_requests);
        let connected = Arc::clone(&self.connected);

        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(response) = serde_json::from_str::<BridgeResponse>(&text) {
                            let requests = pending.read().await;
                            if let Some(sender) = requests.get(&response.request_id) {
                                let _ = sender.send(response).await;
                            }
                        }
                    }
                    Ok(Message::Close(_)) => {
                        info!("[Minecraft] Connection closed");
                        *connected.write().await = false;
                        break;
                    }
                    Err(e) => {
                        error!("[Minecraft] Error receiving message: {}", e);
                    }
                    _ => {}
                }
            }
        });

        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if let Err(e) = write.send(msg).await {
                    error!("[Minecraft] Error sending message: {}", e);
                    break;
                }
            }
        });

        Ok(())
    }

    pub async fn send_message(
        &self,
        msg_type: &str,
        bot_id: Option<&str>,
        data: HashMap<String, Value>,
    ) -> Result<BridgeResponse, String> {
        if !*self.connected.read().await {
            return Err("Not connected to Mineflayer bridge server".to_string());
        }

        let request_id = Uuid::new_v4().to_string();
        let message = BridgeRequest {
            msg_type: msg_type.to_string(),
            request_id: request_id.clone(),
            bot_id: bot_id.map(|s| s.to_string()),
            data: if data.is_empty() { None } else { Some(data) },
        };

        let json = serde_json::to_string(&message)
            .map_err(|e| format!("Failed to serialize message: {}", e))?;

        let (tx, mut rx) = mpsc::channel::<BridgeResponse>(1);
        self.pending_requests
            .write()
            .await
            .insert(request_id.clone(), tx);

        if let Some(sender) = self.sender.read().await.as_ref() {
            sender
                .send(Message::Text(json.into()))
                .await
                .map_err(|e| format!("Failed to send message: {}", e))?;
        }

        debug!("[Minecraft] Sent message: {} ({})", msg_type, request_id);

        let response = tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv())
            .await
            .map_err(|_| format!("Request timeout for {}", msg_type))?
            .ok_or_else(|| "No response received".to_string())?;

        self.pending_requests.write().await.remove(&request_id);

        if !response.success {
            return Err(response.error.unwrap_or_else(|| "Unknown error".to_string()));
        }

        Ok(response)
    }

    pub async fn health(&self) -> Result<bool, String> {
        let response = self.send_message("health", None, HashMap::new()).await?;
        Ok(response
            .data
            .as_ref()
            .and_then(|d| d.get("status"))
            .and_then(|v| v.as_str())
            == Some("ok"))
    }
}

