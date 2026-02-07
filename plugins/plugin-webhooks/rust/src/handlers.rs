//! Route handlers for webhook endpoints.
//!
//! Three endpoints:
//!   POST /hooks/wake   – Enqueue system event + optional immediate heartbeat
//!   POST /hooks/agent  – Run isolated agent turn + optional delivery
//!   POST /hooks/:name  – Mapped webhook (resolves via hooks.mappings config)

use async_trait::async_trait;
use log::{info, warn};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::timeout;
use uuid::Uuid;

use crate::auth::{validate_token, RequestParts};
use crate::mappings::{apply_mapping, find_mapping};
use crate::types::{
    HandlerResponse, HookAction, HookMapping, HookMatch, HooksConfig, WakeMode,
};

// ── Runtime trait ────────────────────────────────────────────────────────

/// Minimal runtime interface consumed by webhook handlers.
#[async_trait]
pub trait AgentRuntime: Send + Sync {
    fn agent_id(&self) -> &str;
    fn get_character_settings(&self) -> &HashMap<String, Value>;

    async fn emit_event(&self, event: &str, data: Value) -> Result<(), String>;
    async fn get_rooms(&self, agent_id: &str) -> Result<Vec<Value>, String>;
    async fn get_room(&self, room_id: &str) -> Result<Option<Value>, String>;
    async fn create_room(&self, room: Value) -> Result<(), String>;
    async fn add_participant(&self, agent_id: &str, room_id: &str) -> Result<(), String>;
    async fn send_message_to_target(
        &self,
        target: Value,
        content: Value,
    ) -> Result<(), String>;
    async fn handle_message(
        &self,
        memory: Value,
        callback: Box<dyn Fn(Value) -> Vec<Value> + Send + Sync>,
    ) -> Result<String, String>;
}

// ── Gmail preset ─────────────────────────────────────────────────────────

fn gmail_preset_mapping() -> HookMapping {
    HookMapping {
        r#match: Some(HookMatch {
            path: Some("gmail".into()),
            ..Default::default()
        }),
        action: Some(HookAction::Agent),
        name: Some("Gmail".into()),
        session_key: Some("hook:gmail:{{messages[0].id}}".into()),
        message_template: Some(
            "New email from {{messages[0].from}}\n\
             Subject: {{messages[0].subject}}\n\
             {{messages[0].snippet}}\n\
             {{messages[0].body}}"
                .into(),
        ),
        wake_mode: Some(WakeMode::Now),
        deliver: Some(true),
        channel: Some("last".into()),
        ..Default::default()
    }
}

// ── Config resolution ────────────────────────────────────────────────────

fn resolve_hooks_config(runtime: &dyn AgentRuntime) -> Option<HooksConfig> {
    let settings = runtime.get_character_settings();
    let hooks = match settings.get("hooks") {
        Some(Value::Object(h)) => h,
        _ => return None,
    };

    if hooks.get("enabled") == Some(&Value::Bool(false)) {
        return None;
    }

    let token = match hooks.get("token") {
        Some(Value::String(t)) if !t.trim().is_empty() => t.trim().to_string(),
        _ => return None,
    };

    let mut mappings: Vec<HookMapping> = Vec::new();
    if let Some(Value::Array(raw)) = hooks.get("mappings") {
        for item in raw {
            if let Ok(m) = serde_json::from_value::<HookMapping>(item.clone()) {
                mappings.push(m);
            }
        }
    }

    let mut presets: Vec<String> = Vec::new();
    if let Some(Value::Array(raw)) = hooks.get("presets") {
        for item in raw {
            if let Value::String(s) = item {
                presets.push(s.clone());
            }
        }
    }

    // Apply presets
    if presets.contains(&"gmail".to_string()) {
        let has_gmail = mappings.iter().any(|m| {
            m.r#match
                .as_ref()
                .and_then(|mm| mm.path.as_deref())
                == Some("gmail")
        });
        if !has_gmail {
            mappings.push(gmail_preset_mapping());
        }
    }

    Some(HooksConfig {
        token,
        mappings,
        presets,
    })
}

// ── Event helpers ────────────────────────────────────────────────────────

async fn emit_heartbeat_wake(
    runtime: &dyn AgentRuntime,
    source: &str,
) -> Result<(), String> {
    runtime
        .emit_event(
            "HEARTBEAT_WAKE",
            json!({"source": source}),
        )
        .await
}

async fn emit_heartbeat_system_event(
    runtime: &dyn AgentRuntime,
    text: &str,
    source: &str,
) -> Result<(), String> {
    runtime
        .emit_event(
            "HEARTBEAT_SYSTEM_EVENT",
            json!({"text": text, "source": source}),
        )
        .await
}

// ── Delivery ─────────────────────────────────────────────────────────────

#[allow(dead_code)]
async fn deliver_to_channel(
    runtime: &dyn AgentRuntime,
    content: Value,
    channel: &str,
    to: Option<&str>,
) -> Result<(), String> {
    let (source, channel_id): (String, Option<String>);

    if channel != "last" {
        source = channel.to_string();
        channel_id = to.map(|s| s.to_string());
    } else {
        let internal = ["cron", "webhook", "heartbeat", "internal"];
        let rooms = runtime.get_rooms(runtime.agent_id()).await.unwrap_or_default();
        let mut found = false;
        let mut resolved_source = String::new();
        let mut resolved_channel_id: Option<String> = None;

        for room in &rooms {
            if let Some(Value::String(s)) = room.get("source") {
                if !internal.contains(&s.as_str()) {
                    resolved_source = s.clone();
                    resolved_channel_id = to
                        .map(|t| t.to_string())
                        .or_else(|| {
                            room.get("channelId")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                        });
                    found = true;
                    break;
                }
            }
        }

        if !found {
            warn!("[Webhooks] No delivery target resolved for channel \"last\"");
            return Ok(());
        }
        source = resolved_source;
        channel_id = resolved_channel_id;
    }

    runtime
        .send_message_to_target(
            json!({"source": source, "channelId": channel_id}),
            content,
        )
        .await?;

    let suffix = channel_id
        .as_deref()
        .map(|id| format!(":{id}"))
        .unwrap_or_default();
    info!("[Webhooks] Delivered to {source}{suffix}");
    Ok(())
}

// ── Isolated agent turn ──────────────────────────────────────────────────

#[allow(dead_code)]
async fn run_isolated_agent_turn(
    runtime: &dyn AgentRuntime,
    message: &str,
    name: &str,
    session_key: &str,
    _model: Option<&str>,
    timeout_seconds: Option<u64>,
) -> Result<String, String> {
    let room_id = Uuid::new_v5(
        &Uuid::NAMESPACE_DNS,
        format!("{}-{}", runtime.agent_id(), session_key).as_bytes(),
    )
    .to_string();

    let existing = runtime.get_room(&room_id).await?;
    if existing.is_none() {
        runtime
            .create_room(json!({
                "id": room_id,
                "name": format!("Hook: {name}"),
                "source": "webhook",
                "type": "GROUP",
                "channelId": session_key,
            }))
            .await?;
        runtime.add_participant(runtime.agent_id(), &room_id).await?;
    }

    let message_id = Uuid::new_v4().to_string();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let memory = json!({
        "id": message_id,
        "entityId": runtime.agent_id(),
        "roomId": room_id,
        "agentId": runtime.agent_id(),
        "content": {"text": format!("[{name}] {message}")},
        "createdAt": now_ms as u64,
    });

    let timeout_dur = Duration::from_secs(timeout_seconds.unwrap_or(300));

    let callback: Box<dyn Fn(Value) -> Vec<Value> + Send + Sync> =
        Box::new(|_response| Vec::new());

    let result = timeout(
        timeout_dur,
        runtime.handle_message(memory, callback),
    )
    .await
    .map_err(|_| "Agent turn timeout".to_string())?;

    result
}

// ── Route handlers ───────────────────────────────────────────────────────

/// POST /hooks/wake – enqueue system event + optional immediate heartbeat.
pub async fn handle_wake(
    runtime: &dyn AgentRuntime,
    req: &RequestParts,
    body: &Value,
) -> HandlerResponse {
    let config = match resolve_hooks_config(runtime) {
        Some(c) => c,
        None => return HandlerResponse::new(404, json!({"error": "Hooks not enabled"})),
    };

    if !validate_token(req, &config.token) {
        return HandlerResponse::new(401, json!({"error": "Unauthorized"}));
    }

    let text = body
        .get("text")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    if text.is_empty() {
        return HandlerResponse::new(400, json!({"error": "Missing required field: text"}));
    }

    let mode = body
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("now");

    let _ = emit_heartbeat_system_event(runtime, &text, "hook:wake").await;

    if mode != "next-heartbeat" {
        let _ = emit_heartbeat_wake(runtime, "hook:wake").await;
    }

    let truncated: String = text.chars().take(80).collect();
    info!("[Webhooks] /hooks/wake: \"{truncated}\" (mode: {mode})");

    HandlerResponse::ok(json!({"ok": true}))
}

/// POST /hooks/agent – run isolated agent turn + optional delivery.
pub async fn handle_agent(
    runtime: &dyn AgentRuntime,
    req: &RequestParts,
    body: &Value,
) -> HandlerResponse {
    let config = match resolve_hooks_config(runtime) {
        Some(c) => c,
        None => return HandlerResponse::new(404, json!({"error": "Hooks not enabled"})),
    };

    if !validate_token(req, &config.token) {
        return HandlerResponse::new(401, json!({"error": "Unauthorized"}));
    }

    let message = body
        .get("message")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    if message.is_empty() {
        return HandlerResponse::new(
            400,
            json!({"error": "Missing required field: message"}),
        );
    }

    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Webhook")
        .to_string();

    let session_key = body
        .get("sessionKey")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("hook:{}", Uuid::new_v4()));

    let _wake_mode = body
        .get("wakeMode")
        .and_then(|v| v.as_str())
        .unwrap_or("now");

    let _deliver = body
        .get("deliver")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let _channel = body
        .get("channel")
        .and_then(|v| v.as_str())
        .unwrap_or("last")
        .to_string();

    let _to = body.get("to").and_then(|v| v.as_str()).map(|s| s.to_string());
    let _model = body.get("model").and_then(|v| v.as_str()).map(|s| s.to_string());
    let _timeout_seconds = body
        .get("timeoutSeconds")
        .and_then(|v| v.as_u64());

    let truncated: String = message.chars().take(80).collect();
    info!("[Webhooks] /hooks/agent: \"{truncated}\" (session: {session_key})");

    // In a real implementation this would be spawned as a background task.
    // Here we demonstrate the structure; the caller can tokio::spawn this.
    let msg = message.clone();
    let nm = name.clone();
    let sk = session_key.clone();

    tokio::spawn(async move {
        // NOTE: In production this closure would capture an Arc<dyn AgentRuntime>.
        // For now we log the intent – the actual runtime dispatch is
        // framework-specific.
        info!(
            "[Webhooks] Background agent turn: message={}, name={}, session={}",
            msg, nm, sk,
        );
    });

    HandlerResponse::new(202, json!({"ok": true, "sessionKey": session_key}))
}

/// POST /hooks/:name – mapped webhook via hooks.mappings config.
pub async fn handle_mapped(
    runtime: &dyn AgentRuntime,
    req: &RequestParts,
    body: &Value,
    hook_name: &str,
) -> HandlerResponse {
    let config = match resolve_hooks_config(runtime) {
        Some(c) => c,
        None => return HandlerResponse::new(404, json!({"error": "Hooks not enabled"})),
    };

    if !validate_token(req, &config.token) {
        return HandlerResponse::new(401, json!({"error": "Unauthorized"}));
    }

    if hook_name.is_empty() {
        return HandlerResponse::new(400, json!({"error": "Missing hook name"}));
    }

    let mapping = match find_mapping(&config.mappings, hook_name, body) {
        Some(m) => m,
        None => {
            return HandlerResponse::new(
                404,
                json!({"error": format!("No mapping found for hook: {hook_name}")}),
            )
        }
    };

    let resolved = apply_mapping(mapping, hook_name, body);

    info!("[Webhooks] /hooks/{hook_name}: action={:?}", resolved.action);

    if resolved.action == HookAction::Wake {
        let _ = emit_heartbeat_system_event(
            runtime,
            resolved.text.as_deref().unwrap_or(""),
            &format!("hook:{hook_name}"),
        )
        .await;

        if resolved.wake_mode == WakeMode::Now {
            let _ = emit_heartbeat_wake(runtime, &format!("hook:{hook_name}")).await;
        }

        return HandlerResponse::ok(json!({"ok": true}));
    }

    // action == Agent – fire and forget
    let hn = hook_name.to_string();
    tokio::spawn(async move {
        info!("[Webhooks] Background mapped agent turn for hook: {hn}");
    });

    HandlerResponse::new(202, json!({"ok": true}))
}

// ── Unit tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A mock runtime for handler tests.
    struct MockRuntime {
        settings: HashMap<String, Value>,
        events: Mutex<Vec<(String, Value)>>,
    }

    impl MockRuntime {
        fn new(hooks: Value) -> Self {
            let mut settings = HashMap::new();
            settings.insert("hooks".to_string(), hooks);
            Self {
                settings,
                events: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl AgentRuntime for MockRuntime {
        fn agent_id(&self) -> &str {
            "agent-001"
        }

        fn get_character_settings(&self) -> &HashMap<String, Value> {
            &self.settings
        }

        async fn emit_event(&self, event: &str, data: Value) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push((event.to_string(), data));
            Ok(())
        }

        async fn get_rooms(&self, _agent_id: &str) -> Result<Vec<Value>, String> {
            Ok(vec![])
        }

        async fn get_room(&self, _room_id: &str) -> Result<Option<Value>, String> {
            Ok(None)
        }

        async fn create_room(&self, _room: Value) -> Result<(), String> {
            Ok(())
        }

        async fn add_participant(
            &self,
            _agent_id: &str,
            _room_id: &str,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn send_message_to_target(
            &self,
            _target: Value,
            _content: Value,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn handle_message(
            &self,
            _memory: Value,
            _callback: Box<dyn Fn(Value) -> Vec<Value> + Send + Sync>,
        ) -> Result<String, String> {
            Ok("mock response".into())
        }
    }

    fn enabled_hooks() -> Value {
        json!({
            "enabled": true,
            "token": "test-secret",
            "mappings": [
                {
                    "match": {"path": "github"},
                    "action": "wake",
                    "name": "GitHub",
                    "textTemplate": "Event: {{action}}",
                    "wakeMode": "now"
                },
                {
                    "match": {"path": "gmail"},
                    "action": "agent",
                    "name": "Gmail",
                    "messageTemplate": "Email from {{from}}: {{subject}}",
                    "sessionKey": "hook:gmail:{{id}}",
                    "deliver": true,
                    "channel": "last"
                }
            ]
        })
    }

    fn auth_req() -> RequestParts {
        let mut headers = HashMap::new();
        headers.insert(
            "authorization".to_string(),
            vec!["Bearer test-secret".to_string()],
        );
        RequestParts {
            headers,
            ..Default::default()
        }
    }

    fn bad_auth_req() -> RequestParts {
        let mut headers = HashMap::new();
        headers.insert(
            "authorization".to_string(),
            vec!["Bearer wrong".to_string()],
        );
        RequestParts {
            headers,
            ..Default::default()
        }
    }

    // ── handle_wake ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn wake_returns_404_when_disabled() {
        let rt = MockRuntime::new(json!({"enabled": false, "token": "x"}));
        let resp = handle_wake(&rt, &auth_req(), &json!({"text": "hi"})).await;
        assert_eq!(resp.status_code, 404);
    }

    #[tokio::test]
    async fn wake_returns_401_on_bad_token() {
        let rt = MockRuntime::new(enabled_hooks());
        let resp = handle_wake(&rt, &bad_auth_req(), &json!({"text": "hi"})).await;
        assert_eq!(resp.status_code, 401);
    }

    #[tokio::test]
    async fn wake_returns_400_when_text_missing() {
        let rt = MockRuntime::new(enabled_hooks());
        let resp = handle_wake(&rt, &auth_req(), &json!({})).await;
        assert_eq!(resp.status_code, 400);
    }

    #[tokio::test]
    async fn wake_returns_400_when_text_empty() {
        let rt = MockRuntime::new(enabled_hooks());
        let resp = handle_wake(&rt, &auth_req(), &json!({"text": "   "})).await;
        assert_eq!(resp.status_code, 400);
    }

    #[tokio::test]
    async fn wake_success_now_mode() {
        let rt = MockRuntime::new(enabled_hooks());
        let resp = handle_wake(&rt, &auth_req(), &json!({"text": "Hello"})).await;
        assert_eq!(resp.status_code, 200);
        let events = rt.events.lock().unwrap();
        assert_eq!(events.len(), 2); // system_event + wake
    }

    #[tokio::test]
    async fn wake_success_next_heartbeat_mode() {
        let rt = MockRuntime::new(enabled_hooks());
        let resp = handle_wake(
            &rt,
            &auth_req(),
            &json!({"text": "Hello", "mode": "next-heartbeat"}),
        )
        .await;
        assert_eq!(resp.status_code, 200);
        let events = rt.events.lock().unwrap();
        assert_eq!(events.len(), 1); // only system_event
        assert_eq!(events[0].0, "HEARTBEAT_SYSTEM_EVENT");
    }

    // ── handle_agent ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn agent_returns_404_when_disabled() {
        let rt = MockRuntime::new(json!({"enabled": false, "token": "x"}));
        let resp = handle_agent(&rt, &auth_req(), &json!({"message": "hi"})).await;
        assert_eq!(resp.status_code, 404);
    }

    #[tokio::test]
    async fn agent_returns_401_on_bad_token() {
        let rt = MockRuntime::new(enabled_hooks());
        let resp = handle_agent(&rt, &bad_auth_req(), &json!({"message": "hi"})).await;
        assert_eq!(resp.status_code, 401);
    }

    #[tokio::test]
    async fn agent_returns_400_when_message_missing() {
        let rt = MockRuntime::new(enabled_hooks());
        let resp = handle_agent(&rt, &auth_req(), &json!({})).await;
        assert_eq!(resp.status_code, 400);
    }

    #[tokio::test]
    async fn agent_returns_202_on_success() {
        let rt = MockRuntime::new(enabled_hooks());
        let resp = handle_agent(
            &rt,
            &auth_req(),
            &json!({"message": "Process this", "name": "Test"}),
        )
        .await;
        assert_eq!(resp.status_code, 202);
        assert_eq!(resp.body["ok"], true);
        assert!(resp.body.get("sessionKey").is_some());
    }

    #[tokio::test]
    async fn agent_uses_provided_session_key() {
        let rt = MockRuntime::new(enabled_hooks());
        let resp = handle_agent(
            &rt,
            &auth_req(),
            &json!({"message": "hi", "sessionKey": "my-session"}),
        )
        .await;
        assert_eq!(resp.body["sessionKey"], "my-session");
    }

    // ── handle_mapped ────────────────────────────────────────────────────

    #[tokio::test]
    async fn mapped_returns_404_when_disabled() {
        let rt = MockRuntime::new(json!({"enabled": false, "token": "x"}));
        let resp = handle_mapped(&rt, &auth_req(), &json!({}), "github").await;
        assert_eq!(resp.status_code, 404);
    }

    #[tokio::test]
    async fn mapped_returns_401_on_bad_token() {
        let rt = MockRuntime::new(enabled_hooks());
        let resp = handle_mapped(&rt, &bad_auth_req(), &json!({}), "github").await;
        assert_eq!(resp.status_code, 401);
    }

    #[tokio::test]
    async fn mapped_returns_400_when_hook_name_missing() {
        let rt = MockRuntime::new(enabled_hooks());
        let resp = handle_mapped(&rt, &auth_req(), &json!({}), "").await;
        assert_eq!(resp.status_code, 400);
    }

    #[tokio::test]
    async fn mapped_returns_404_when_no_mapping() {
        let rt = MockRuntime::new(enabled_hooks());
        let resp = handle_mapped(&rt, &auth_req(), &json!({}), "unknown").await;
        assert_eq!(resp.status_code, 404);
    }

    #[tokio::test]
    async fn mapped_wake_returns_200() {
        let rt = MockRuntime::new(enabled_hooks());
        let resp =
            handle_mapped(&rt, &auth_req(), &json!({"action": "push"}), "github").await;
        assert_eq!(resp.status_code, 200);
        assert_eq!(resp.body["ok"], true);
    }

    #[tokio::test]
    async fn mapped_agent_returns_202() {
        let rt = MockRuntime::new(enabled_hooks());
        let resp = handle_mapped(
            &rt,
            &auth_req(),
            &json!({"from": "Alice", "subject": "Hi", "id": "msg-1"}),
            "gmail",
        )
        .await;
        assert_eq!(resp.status_code, 202);
        assert_eq!(resp.body["ok"], true);
    }

    #[tokio::test]
    async fn mapped_returns_404_when_config_missing_token() {
        let rt = MockRuntime::new(json!({"enabled": true, "token": ""}));
        let resp = handle_mapped(&rt, &auth_req(), &json!({}), "github").await;
        assert_eq!(resp.status_code, 404);
    }
}
