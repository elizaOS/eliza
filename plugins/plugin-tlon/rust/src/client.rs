//! Tlon/Urbit HTTP API client.

use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE, COOKIE};
use reqwest::Client;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

use crate::config::normalize_ship;
use crate::error::{Result, TlonError};

/// Callback for subscription events.
pub type EventCallback = Box<dyn Fn(serde_json::Value) + Send + Sync>;
/// Callback for subscription errors.
pub type ErrorCallback = Box<dyn Fn(TlonError) + Send + Sync>;
/// Callback for subscription quit.
pub type QuitCallback = Box<dyn Fn() + Send + Sync>;

/// Subscription parameters.
pub struct SubscribeParams {
    /// App name.
    pub app: String,
    /// Subscription path.
    pub path: String,
    /// Event callback.
    pub event: Option<EventCallback>,
    /// Error callback.
    pub err: Option<ErrorCallback>,
    /// Quit callback.
    pub quit: Option<QuitCallback>,
}

/// Poke parameters.
pub struct PokeParams {
    /// App name.
    pub app: String,
    /// Mark.
    pub mark: String,
    /// JSON payload.
    pub json: serde_json::Value,
}

/// Event handlers for a subscription.
#[allow(dead_code)]
struct EventHandlers {
    event: Option<EventCallback>,
    err: Option<ErrorCallback>,
    quit: Option<QuitCallback>,
}

/// Internal subscription representation.
#[derive(Clone)]
struct Subscription {
    id: i64,
    ship: String,
    app: String,
    path: String,
}

/// Client state.
struct ClientState {
    is_connected: bool,
    subscriptions: Vec<Subscription>,
    event_handlers: HashMap<i64, EventHandlers>,
    reconnect_attempts: u32,
}

impl Default for ClientState {
    fn default() -> Self {
        Self {
            is_connected: false,
            subscriptions: Vec::new(),
            event_handlers: HashMap::new(),
            reconnect_attempts: 0,
        }
    }
}

/// Tlon/Urbit HTTP API client with SSE support.
pub struct TlonClient {
    url: String,
    cookie: String,
    ship: String,
    #[allow(dead_code)]
    channel_id: String,
    channel_url: String,
    http_client: Client,
    state: Arc<RwLock<ClientState>>,
    #[allow(dead_code)]
    auto_reconnect: bool,
    #[allow(dead_code)]
    max_reconnect_attempts: u32,
    #[allow(dead_code)]
    reconnect_delay_ms: u64,
    #[allow(dead_code)]
    max_reconnect_delay_ms: u64,
}

impl TlonClient {
    /// Creates a new client with an existing cookie.
    pub fn new(url: &str, cookie: &str, ship: Option<&str>) -> Self {
        let channel_id = generate_channel_id();
        let clean_url = url.trim_end_matches('/');
        let resolved_ship = ship.map(|s| normalize_ship(s)).unwrap_or_else(|| {
            // Try to extract ship from URL
            url::Url::parse(clean_url)
                .ok()
                .and_then(|u| u.host_str().map(|h| h.split('.').next().unwrap_or(h).to_string()))
                .unwrap_or_default()
        });

        Self {
            url: clean_url.to_string(),
            cookie: cookie.split(';').next().unwrap_or(cookie).to_string(),
            ship: resolved_ship,
            channel_id: channel_id.clone(),
            channel_url: format!("{}/~/channel/{}", clean_url, channel_id),
            http_client: Client::new(),
            state: Arc::new(RwLock::new(ClientState::default())),
            auto_reconnect: true,
            max_reconnect_attempts: 10,
            reconnect_delay_ms: 1000,
            max_reconnect_delay_ms: 30000,
        }
    }

    /// Returns the ship name.
    pub fn ship(&self) -> &str {
        &self.ship
    }

    /// Returns whether the client is connected.
    pub async fn is_connected(&self) -> bool {
        self.state.read().await.is_connected
    }

    /// Authenticates with the Urbit ship and creates a new client.
    pub async fn authenticate(url: &str, code: &str, ship: Option<&str>) -> Result<Self> {
        let clean_url = url.trim_end_matches('/');
        let login_url = format!("{}/~/login", clean_url);

        let client = Client::new();
        let response = client
            .post(&login_url)
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(format!("password={}", code))
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(TlonError::AuthenticationFailed(format!(
                "Login failed with status {}",
                response.status()
            )));
        }

        let cookie = response
            .headers()
            .get("set-cookie")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| TlonError::AuthenticationFailed("No cookie received".to_string()))?;

        Ok(Self::new(clean_url, cookie, ship))
    }

    /// Subscribe to an app's path.
    pub async fn subscribe(&self, params: SubscribeParams) -> Result<i64> {
        let mut state = self.state.write().await;
        let sub_id = (state.subscriptions.len() + 1) as i64;

        let subscription = Subscription {
            id: sub_id,
            ship: self.ship.clone(),
            app: params.app,
            path: params.path,
        };

        state.subscriptions.push(subscription.clone());
        state.event_handlers.insert(
            sub_id,
            EventHandlers {
                event: params.event,
                err: params.err,
                quit: params.quit,
            },
        );

        if state.is_connected {
            drop(state); // Release lock before HTTP call
            self.send_subscription(&subscription).await?;
        }

        Ok(sub_id)
    }

    async fn send_subscription(&self, subscription: &Subscription) -> Result<()> {
        let payload = serde_json::json!([{
            "id": subscription.id,
            "action": "subscribe",
            "ship": subscription.ship,
            "app": subscription.app,
            "path": subscription.path
        }]);

        let response = self
            .http_client
            .put(&self.channel_url)
            .headers(self.default_headers())
            .json(&payload)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() && status.as_u16() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            return Err(TlonError::SubscribeFailed(format!(
                "Status {}: {}",
                status,
                error_text
            )));
        }

        Ok(())
    }

    /// Connect and start receiving events.
    pub async fn connect(&self) -> Result<()> {
        let subscriptions = {
            let state = self.state.read().await;
            state.subscriptions.clone()
        };

        // Create channel with subscriptions
        let payload: Vec<serde_json::Value> = subscriptions
            .iter()
            .map(|s| {
                serde_json::json!({
                    "id": s.id,
                    "action": "subscribe",
                    "ship": s.ship,
                    "app": s.app,
                    "path": s.path
                })
            })
            .collect();

        let response = self
            .http_client
            .put(&self.channel_url)
            .headers(self.default_headers())
            .json(&payload)
            .send()
            .await?;

        if !response.status().is_success() && response.status().as_u16() != 204 {
            return Err(TlonError::ConnectionFailed(format!(
                "Channel creation failed: {}",
                response.status()
            )));
        }

        // Activate channel with a poke
        let poke_payload = serde_json::json!([{
            "id": chrono::Utc::now().timestamp_millis(),
            "action": "poke",
            "ship": self.ship,
            "app": "hood",
            "mark": "helm-hi",
            "json": "Opening API channel"
        }]);

        let poke_response = self
            .http_client
            .put(&self.channel_url)
            .headers(self.default_headers())
            .json(&poke_payload)
            .send()
            .await?;

        if !poke_response.status().is_success() && poke_response.status().as_u16() != 204 {
            return Err(TlonError::ConnectionFailed(format!(
                "Channel activation failed: {}",
                poke_response.status()
            )));
        }

        {
            let mut state = self.state.write().await;
            state.is_connected = true;
            state.reconnect_attempts = 0;
        }

        info!("[Tlon] Connected to ~{}", self.ship);
        Ok(())
    }

    /// Send a poke to an app.
    pub async fn poke(&self, params: PokeParams) -> Result<i64> {
        let poke_id = chrono::Utc::now().timestamp_millis();
        let payload = serde_json::json!([{
            "id": poke_id,
            "action": "poke",
            "ship": self.ship,
            "app": params.app,
            "mark": params.mark,
            "json": params.json
        }]);

        let response = self
            .http_client
            .put(&self.channel_url)
            .headers(self.default_headers())
            .json(&payload)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() && status.as_u16() != 204 {
            let error_text = response.text().await.unwrap_or_default();
            return Err(TlonError::PokeFailed(format!(
                "Status {}: {}",
                status,
                error_text
            )));
        }

        Ok(poke_id)
    }

    /// Perform a scry (read-only query).
    pub async fn scry<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let scry_url = format!("{}/~/scry{}", self.url, path);
        let response = self
            .http_client
            .get(&scry_url)
            .header(COOKIE, &self.cookie)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(TlonError::ScryFailed(format!(
                "Status {} for path {}",
                response.status(),
                path
            )));
        }

        let result = response.json().await?;
        Ok(result)
    }

    /// Close the connection.
    pub async fn close(&self) -> Result<()> {
        let subscriptions = {
            let mut state = self.state.write().await;
            state.is_connected = false;
            state.subscriptions.clone()
        };

        // Unsubscribe from all
        let unsubscribes: Vec<serde_json::Value> = subscriptions
            .iter()
            .map(|s| {
                serde_json::json!({
                    "id": s.id,
                    "action": "unsubscribe",
                    "subscription": s.id
                })
            })
            .collect();

        if !unsubscribes.is_empty() {
            let _ = self
                .http_client
                .put(&self.channel_url)
                .headers(self.default_headers())
                .json(&unsubscribes)
                .send()
                .await;
        }

        // Delete channel
        let _ = self
            .http_client
            .delete(&self.channel_url)
            .header(COOKIE, &self.cookie)
            .send()
            .await;

        info!("[Tlon] Disconnected from ~{}", self.ship);
        Ok(())
    }

    fn default_headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(COOKIE, HeaderValue::from_str(&self.cookie).unwrap());
        headers
    }
}

fn generate_channel_id() -> String {
    let timestamp = chrono::Utc::now().timestamp();
    let random: String = (0..6)
        .map(|_| {
            let idx = (rand::random() % 36) as usize;
            if idx < 10 {
                (b'0' + idx as u8) as char
            } else {
                (b'a' + (idx - 10) as u8) as char
            }
        })
        .collect();
    format!("{}-{}", timestamp, random)
}

// Simple thread-safe random for channel ID generation
mod rand {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static SEED: AtomicU64 = AtomicU64::new(0);

    pub fn random() -> u64 {
        let mut seed = SEED.load(Ordering::Relaxed);
        if seed == 0 {
            seed = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos() as u64;
        }
        seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
        SEED.store(seed, Ordering::Relaxed);
        seed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_channel_id() {
        let id1 = generate_channel_id();
        let id2 = generate_channel_id();
        assert!(!id1.is_empty());
        assert!(id1.contains('-'));
        // IDs should be different (though this could theoretically fail)
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_client_creation() {
        let client = TlonClient::new(
            "https://sampel-palnet.tlon.network",
            "urbauth-~sampel-palnet=test",
            Some("sampel-palnet"),
        );
        assert_eq!(client.ship(), "sampel-palnet");
        assert!(!client.channel_url.is_empty());
    }
}
