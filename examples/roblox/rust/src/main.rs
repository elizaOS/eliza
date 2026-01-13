use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use elizaos_plugin_roblox::{RobloxClient, RobloxConfig};
use elizaos_plugin_eliza_classic::ElizaClassicPlugin;
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc};
use tower_http::cors::{Any, CorsLayer};

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct RobloxChatRequest {
    #[serde(rename = "playerId")]
    player_id: u64,
    #[serde(rename = "playerName")]
    player_name: String,
    text: String,
    #[serde(rename = "placeId")]
    place_id: Option<String>,
    #[serde(rename = "jobId")]
    job_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct RobloxChatResponse {
    reply: String,
    #[serde(rename = "agentName")]
    agent_name: String,
}

#[derive(Clone)]
struct AppState {
    shared_secret: String,
    agent_name: String,
    eliza: Arc<ElizaClassicPlugin>,
    roblox: Option<Arc<RobloxClient>>,
}

fn is_authorized(headers: &HeaderMap, shared_secret: &str) -> bool {
    if shared_secret.is_empty() {
        return true;
    }
    let provided = headers
        .get("x-eliza-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    provided == shared_secret
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn roblox_chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RobloxChatRequest>,
) -> impl IntoResponse {
    if !is_authorized(&headers, &state.shared_secret) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Unauthorized"})))
            .into_response();
    }

    if body.text.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "text is required"})),
        )
            .into_response();
    }

    let reply = state.eliza.generate_response(&body.text);

    // Optional: echo reply back into Roblox via Open Cloud publish (MessagingService).
    if std::env::var("ROBLOX_ECHO_TO_GAME")
        .map(|v| v.to_lowercase() == "true")
        .unwrap_or(false)
    {
        if let Some(client) = &state.roblox {
            let agent_name = state.agent_name.clone();
            let payload = serde_json::json!({
                "type": "agent_message",
                "content": reply.clone(),
                "timestamp": chrono::Utc::now().timestamp_millis(),
                "sender": {
                    "agentId": "rust-bridge",
                    "agentName": agent_name,
                }
            });
            // If dry-run is enabled, this won't hit the network.
            let _ = client.publish_message(&client.config().messaging_topic, payload, None).await;
        }
    }

    (
        StatusCode::OK,
        Json(RobloxChatResponse {
            reply,
            agent_name: state.agent_name.clone(),
        }),
    )
        .into_response()
}

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "3042".to_string())
        .parse()
        .unwrap_or(3042);

    let shared_secret = std::env::var("ELIZA_ROBLOX_SHARED_SECRET").unwrap_or_default();

    let roblox = if std::env::var("ROBLOX_ECHO_TO_GAME")
        .map(|v| v.to_lowercase() == "true")
        .unwrap_or(false)
    {
        // Only create the client if echo is enabled and env vars exist.
        match RobloxConfig::from_env().and_then(RobloxClient::new) {
            Ok(client) => Some(Arc::new(client)),
            Err(_) => None,
        }
    } else {
        None
    };

    let state = AppState {
        shared_secret,
        agent_name: "Eliza".to_string(),
        eliza: Arc::new(ElizaClassicPlugin::new()),
        roblox,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health))
        .route("/roblox/chat", post(roblox_chat))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("🌐 Roblox agent bridge listening on http://localhost:{port}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_authorized_no_secret() {
        let headers = HeaderMap::new();
        assert!(is_authorized(&headers, ""));
    }

    #[test]
    fn test_is_authorized_with_secret() {
        let mut headers = HeaderMap::new();
        headers.insert("x-eliza-secret", "s3cr3t".parse().unwrap());
        assert!(is_authorized(&headers, "s3cr3t"));
        assert!(!is_authorized(&headers, "wrong"));
    }

    #[tokio::test]
    async fn test_echo_is_best_effort_with_dry_run_client() {
        std::env::set_var("ROBLOX_ECHO_TO_GAME", "true");

        let cfg = RobloxConfig::new("test-key", "12345").with_dry_run(true);
        let client = RobloxClient::new(cfg).unwrap();

        let state = AppState {
            shared_secret: "".to_string(),
            agent_name: "Eliza".to_string(),
            eliza: Arc::new(ElizaClassicPlugin::new()),
            roblox: Some(Arc::new(client)),
        };

        let headers = HeaderMap::new();
        let body = RobloxChatRequest {
            player_id: 1,
            player_name: "A".to_string(),
            text: "hello".to_string(),
            place_id: None,
            job_id: None,
        };

        // Should not panic and should return OK.
        let resp = roblox_chat(State(state), headers, Json(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
    }
}

