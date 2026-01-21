//! X (Twitter) main service orchestration.

use crate::client::TwitterClient;
use crate::error::{Result, XAIError};
use crate::types::{Post, Profile, TwitterConfig};
use elizaos::runtime::Service as RuntimeService;
use elizaos::services::IMessageService;
use elizaos::types::{string_to_uuid, ChannelType, Content, Entity, Memory, Room, World};
use elizaos::AgentRuntime;
use rand::Rng;
use std::any::Any;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;
use tokio::task::JoinHandle;
use tokio::time::Duration;
use tracing::{debug, info, warn};

/// X Client Instance - orchestrates X (formerly Twitter) functionality.
///
/// Today this implements the replies/mentions loop (parity with TS `XInteractionClient`):
/// - Poll mentions of the authenticated user
/// - De-dupe via persisted memories
/// - Route incoming posts into the canonical Rust message pipeline
/// - Post replies via the message-service callback
pub struct XService {
    is_running: Arc<AtomicBool>,
    handle: TokioMutex<Option<JoinHandle<()>>>,
}

impl XService {
    /// Service type identifier.
    pub const SERVICE_TYPE: &'static str = "x";

    /// Creates a new X service instance (not started).
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
            handle: TokioMutex::new(None),
        }
    }

    /// Starts the X service.
    ///
    /// If no features are enabled in settings, this will be a no-op start (useful for tests).
    pub async fn start(runtime: Arc<AgentRuntime>, settings: XServiceSettings) -> Result<Arc<Self>> {
        let svc = Arc::new(Self::new());

        if !settings.post_enabled
            && !settings.replies_enabled
            && !settings.actions_enabled
            && !settings.discovery_enabled
        {
            svc.is_running.store(true, Ordering::SeqCst);
            return Ok(svc);
        }

        if settings.replies_enabled {
            info!("X replies ENABLED");
        }
        if settings.post_enabled {
            info!("X posting ENABLED");
        }
        if settings.actions_enabled {
            info!("X timeline actions ENABLED");
        }
        if settings.discovery_enabled {
            info!("X discovery ENABLED");
        }

        let config = TwitterConfig::from_env().map_err(|e| XAIError::ConfigError(e.to_string()))?;
        let client = Arc::new(TokioMutex::new(TwitterClient::new(config)?));

        let me = {
            let mut c = client.lock().await;
            c.me().await?
        };

        svc.is_running.store(true, Ordering::SeqCst);

        if settings.replies_enabled {
            let is_running = Arc::clone(&svc.is_running);
            let handle = tokio::spawn(run_mentions_loop(
                Arc::clone(&runtime),
                client,
                me,
                settings,
                is_running,
            ));
            *svc.handle.lock().await = Some(handle);
        }

        Ok(svc)
    }

    /// Checks if the service is running.
    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }
}

impl Default for XService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl RuntimeService for XService {
    fn service_type(&self) -> &str {
        Self::SERVICE_TYPE
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn stop(&self) -> anyhow::Result<()> {
        self.is_running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.handle.lock().await.take() {
            let _ = handle.await;
        }
        Ok(())
    }
}

/// Settings for the X service.
#[derive(Debug, Clone)]
pub struct XServiceSettings {
    /// Whether posting is enabled.
    pub post_enabled: bool,
    /// Whether replies are enabled.
    pub replies_enabled: bool,
    /// Whether timeline actions are enabled.
    pub actions_enabled: bool,
    /// Whether discovery is enabled.
    pub discovery_enabled: bool,
    /// Min interval between cycles (minutes).
    pub engagement_interval_min: u64,
    /// Max interval between cycles (minutes).
    pub engagement_interval_max: u64,
    /// Max mention results per poll.
    pub max_results: u32,
}

impl Default for XServiceSettings {
    fn default() -> Self {
        Self {
            post_enabled: false,
            replies_enabled: true,
            actions_enabled: false,
            discovery_enabled: false,
            engagement_interval_min: 20,
            engagement_interval_max: 40,
            max_results: 25,
        }
    }
}

impl XServiceSettings {
    /// Build settings from environment variables (mirrors the TS example flags).
    pub fn from_env() -> anyhow::Result<Self> {
        fn env_bool(name: &str, default: bool) -> bool {
            std::env::var(name)
                .ok()
                .map(|v| v.to_lowercase() == "true")
                .unwrap_or(default)
        }
        fn env_u64(name: &str, default: u64) -> u64 {
            std::env::var(name)
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(default)
        }
        fn env_u32(name: &str, default: u32) -> u32 {
            std::env::var(name)
                .ok()
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(default)
        }

        Ok(Self {
            post_enabled: env_bool("X_ENABLE_POST", false),
            replies_enabled: env_bool("X_ENABLE_REPLIES", true),
            actions_enabled: env_bool("X_ENABLE_ACTIONS", false),
            discovery_enabled: env_bool("X_ENABLE_DISCOVERY", false),
            engagement_interval_min: env_u64("X_ENGAGEMENT_INTERVAL_MIN", 20),
            engagement_interval_max: env_u64("X_ENGAGEMENT_INTERVAL_MAX", 40),
            max_results: env_u32("X_MAX_ENGAGEMENTS_PER_RUN", 25),
        })
    }
}

async fn run_mentions_loop(
    runtime: Arc<AgentRuntime>,
    client: Arc<TokioMutex<TwitterClient>>,
    me: Profile,
    settings: XServiceSettings,
    is_running: Arc<AtomicBool>,
) {
    let query = format!("@{}", me.username);

    while is_running.load(Ordering::SeqCst) {
        let cursor = match load_cursor(&runtime).await {
            Ok(v) => v,
            Err(e) => {
                warn!("Failed to load X cursor: {}", e);
                None
            }
        };

        let resp = {
            let c = client.lock().await;
            c.search_posts(&query, settings.max_results, Some("recency")).await
        };

        let resp = match resp {
            Ok(r) => r,
            Err(XAIError::TwitterApiError { status: 429, .. }) => {
                warn!("Rate limited (429). Backing off for 60s.");
                tokio::time::sleep(Duration::from_secs(60)).await;
                continue;
            }
            Err(e) => {
                warn!("X API error: {}", e);
                tokio::time::sleep(Duration::from_secs(15)).await;
                continue;
            }
        };

        let mut max_seen: Option<u128> = cursor;
        let mut posts = resp.posts;
        posts.sort_by_key(|p| p.timestamp);

        for post in posts {
            if !is_running.load(Ordering::SeqCst) {
                break;
            }

            if post.username == me.username {
                continue;
            }

            let Some(post_id_num) = parse_u128(&post.id) else {
                continue;
            };
            if let Some(c) = cursor {
                if post_id_num <= c {
                    continue;
                }
            }

            if let Err(e) = process_mention(&runtime, &client, &me, &post).await {
                warn!("Failed to process mention {}: {}", post.id, e);
                continue;
            }

            if max_seen.map(|m| post_id_num > m).unwrap_or(true) {
                max_seen = Some(post_id_num);
            }
        }

        if let Some(m) = max_seen {
            if let Err(e) = save_cursor(&runtime, m).await {
                warn!("Failed to save X cursor: {}", e);
            }
        }

        let sleep_for = {
            let min = settings.engagement_interval_min.min(settings.engagement_interval_max);
            let max = settings.engagement_interval_max.max(min);
            let minutes = if min == max {
                min
            } else {
                rand::thread_rng().gen_range(min..=max)
            };
            Duration::from_secs(minutes.saturating_mul(60))
        };
        tokio::time::sleep(sleep_for).await;
    }
}

async fn process_mention(
    runtime: &AgentRuntime,
    client: &Arc<TokioMutex<TwitterClient>>,
    me: &Profile,
    post: &Post,
) -> anyhow::Result<()> {
    let adapter = runtime
        .get_adapter()
        .ok_or_else(|| anyhow::anyhow!("No database adapter configured (plugin-sql required)"))?;

    let post_mem_id = string_to_uuid(&format!("x-post:{}", post.id));
    if adapter.get_memory_by_id(&post_mem_id).await?.is_some() {
        return Ok(());
    }

    let world_id = string_to_uuid("x-world");
    let room_id = string_to_uuid(&format!(
        "x-room:{}",
        post.conversation_id.as_deref().unwrap_or(&post.id)
    ));
    let author_key = post
        .author_id
        .as_deref()
        .map(|s| format!("x-user:{}", s))
        .unwrap_or_else(|| format!("x-user:{}", post.username));
    let author_id = string_to_uuid(&author_key);

    // Ensure world/room/entity exist (best-effort; adapter handles uniqueness).
    adapter
        .create_world(&World {
            id: world_id.clone(),
            name: Some("X".to_string()),
            agent_id: runtime.agent_id.clone(),
            message_server_id: None,
            metadata: None,
        })
        .await
        .ok();
    adapter
        .create_room(&Room {
            id: room_id.clone(),
            name: Some("X".to_string()),
            agent_id: Some(runtime.agent_id.clone()),
            source: "x".to_string(),
            room_type: ChannelType::THREAD.to_string(),
            channel_id: None,
            message_server_id: None,
            world_id: Some(world_id.clone()),
            metadata: None,
        })
        .await
        .ok();
    adapter
        .create_entity(&Entity {
            id: Some(string_to_uuid(&author_key)),
            names: Some(vec![post.username.clone()]),
            metadata: None,
            agent_id: Some(runtime.agent_id.clone()),
            components: None,
        })
        .await
        .ok();

    let in_reply_to_uuid = post
        .in_reply_to_id
        .as_deref()
        .map(|id| string_to_uuid(&format!("x-post:{}", id)));

    let mut memory = Memory {
        id: Some(post_mem_id.clone()),
        entity_id: author_id,
        agent_id: None,
        room_id: room_id.clone(),
        content: Content {
            text: Some(post.text.clone()),
            source: Some("x".to_string()),
            url: Some(post.permanent_url.clone()),
            in_reply_to: in_reply_to_uuid.map(|u| u.to_string()),
            ..Default::default()
        },
        created_at: Some(post.timestamp),
        embedding: None,
        world_id: Some(world_id),
        unique: Some(true),
        similarity: None,
        metadata: None,
    };

    // Callback posts the reply and returns memory entries for persistence.
    let client_for_cb = Arc::clone(client);
    let reply_to_id = post.id.clone();
    let reply_room_id = room_id;
    let reply_in_reply_to = post_mem_id;
    let agent_id = runtime.agent_id.clone();
    let my_username = me.username.clone();
    let reply_world_id = Some(string_to_uuid("x-world"));
    let callback: elizaos::types::HandlerCallback = Box::new(move |content: Content| {
        let client_for_cb = Arc::clone(&client_for_cb);
        let reply_to_id = reply_to_id.clone();
        let my_username = my_username.clone();
        let reply_room_id = reply_room_id.clone();
        let reply_in_reply_to = reply_in_reply_to.clone();
        let agent_id = agent_id.clone();
        let reply_world_id = reply_world_id.clone();
        Box::pin(async move {
            let text = content.text.unwrap_or_default();
            if text.trim().is_empty() {
                return vec![];
            }
            let created = match {
                let c = client_for_cb.lock().await;
                c.create_reply(&text, &reply_to_id).await
            } {
                Ok(c) => c,
                Err(_) => return vec![],
            };
            let reply_mem = Memory {
                id: Some(string_to_uuid(&format!("x-post:{}", created.id))),
                entity_id: agent_id.clone(),
                agent_id: Some(agent_id),
                room_id: reply_room_id,
                content: Content {
                    text: Some(created.text),
                    source: Some("x".to_string()),
                    url: Some(format!("https://x.com/{}/status/{}", my_username, created.id)),
                    in_reply_to: Some(reply_in_reply_to.to_string()),
                    ..Default::default()
                },
                created_at: None,
                embedding: None,
                world_id: reply_world_id,
                unique: Some(true),
                similarity: None,
                metadata: None,
            };
            vec![reply_mem]
        })
    });

    let _ = runtime
        .message_service()
        .handle_message(runtime, &mut memory, Some(callback), None)
        .await?;

    Ok(())
}

fn parse_u128(s: &str) -> Option<u128> {
    s.trim().parse::<u128>().ok()
}

async fn load_cursor(runtime: &AgentRuntime) -> anyhow::Result<Option<u128>> {
    let Some(adapter) = runtime.get_adapter() else {
        return Ok(None);
    };
    let id = string_to_uuid("xai:x:cursor");
    let Some(mem) = adapter.get_memory_by_id(&id).await? else {
        return Ok(None);
    };
    let txt = mem.content.text.unwrap_or_default();
    Ok(parse_u128(&txt))
}

async fn save_cursor(runtime: &AgentRuntime, cursor: u128) -> anyhow::Result<()> {
    let Some(adapter) = runtime.get_adapter() else {
        return Ok(());
    };
    let id = string_to_uuid("xai:x:cursor");
    let mem = Memory {
        id: Some(id.clone()),
        entity_id: runtime.agent_id.clone(),
        agent_id: Some(runtime.agent_id.clone()),
        room_id: string_to_uuid("xai:x:cursor-room"),
        content: Content {
            text: Some(cursor.to_string()),
            source: Some("x".to_string()),
            content_type: Some("x_cursor".to_string()),
            ..Default::default()
        },
        created_at: None,
        embedding: None,
        world_id: None,
        unique: Some(true),
        similarity: None,
        metadata: None,
    };

    if adapter.get_memory_by_id(&id).await?.is_some() {
        adapter.update_memory(&mem).await?;
    } else {
        adapter.create_memory(&mem, "messages").await?;
    }
    debug!("Saved X cursor: {}", cursor);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_x_service_lifecycle_noop_when_all_disabled() {
        let runtime = Arc::new(AgentRuntime::new(elizaos::runtime::RuntimeOptions {
            check_should_respond: Some(false),
            ..Default::default()
        })
        .await
        .unwrap());

        let settings = XServiceSettings {
            post_enabled: false,
            replies_enabled: false,
            actions_enabled: false,
            discovery_enabled: false,
            ..Default::default()
        };

        let service = XService::start(runtime, settings).await.unwrap();
        assert!(service.is_running());
        service.stop().await.unwrap();
        assert!(!service.is_running());
    }
}
