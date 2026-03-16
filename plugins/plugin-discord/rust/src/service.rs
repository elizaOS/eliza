use async_trait::async_trait;
use serenity::all::{ChannelId, GuildId, MessageId, UserId};
use serenity::client::{Client, Context, EventHandler};
use serenity::model::channel::Message;
use serenity::model::gateway::Ready;
use serenity::model::guild::Member;
use serenity::model::voice::VoiceState;
use serenity::prelude::GatewayIntents;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info};

use crate::config::DiscordConfig;
use crate::error::{DiscordError, Result};
use crate::types::{
    DiscordChannelInfo, DiscordChannelType, DiscordEventType, DiscordMemberPayload,
    DiscordMessagePayload, DiscordVoiceStatePayload, DiscordWorldPayload, Snowflake,
};

/// Maximum length of a single Discord message.
///
/// Discord limits message content to 2000 characters; this is used as a conservative cap when
/// splitting outgoing messages.
pub const MAX_MESSAGE_LENGTH: usize = 2000;

/// Callback invoked when the service emits a Discord event.
///
/// The callback receives the event type and an event-specific JSON payload.
pub type EventCallback = Box<dyn Fn(DiscordEventType, serde_json::Value) + Send + Sync>;

#[derive(Default)]
struct ServiceState {
    is_running: bool,
    event_callback: Option<EventCallback>,
}

struct DiscordEventHandler {
    config: DiscordConfig,
    state: Arc<RwLock<ServiceState>>,
}

#[async_trait]
impl EventHandler for DiscordEventHandler {
    async fn ready(&self, _ctx: Context, ready: Ready) {
        let discriminator = ready
            .user
            .discriminator
            .map(|d| d.to_string())
            .unwrap_or_else(|| "0".to_string());
        info!(
            "Discord bot connected as {}#{}",
            ready.user.name, discriminator
        );

        let state = self.state.read().await;
        if let Some(ref callback) = state.event_callback {
            callback(
                DiscordEventType::WorldConnected,
                serde_json::json!({
                    "bot_id": ready.user.id.to_string(),
                    "bot_name": ready.user.name,
                    "guilds": ready.guilds.len()
                }),
            );
        }
    }

    async fn message(&self, ctx: Context, msg: Message) {
        if msg.author.id == ctx.cache.current_user().id {
            return;
        }

        if msg.author.bot && self.config.should_ignore_bot_messages {
            debug!("Ignoring bot message from {}", msg.author.name);
            return;
        }

        if msg.guild_id.is_none() && self.config.should_ignore_direct_messages {
            debug!("Ignoring DM from {}", msg.author.name);
            return;
        }

        if !self.config.channel_ids.is_empty() {
            let channel_id_str = msg.channel_id.to_string();
            if !self.config.channel_ids.contains(&channel_id_str) {
                debug!("Ignoring message in non-allowed channel {}", channel_id_str);
                return;
            }
        }

        if self.config.should_respond_only_to_mentions {
            let bot_id = ctx.cache.current_user().id;
            if !msg.mentions.iter().any(|u| u.id == bot_id) {
                debug!("Ignoring message without bot mention");
                return;
            }
        }

        let payload = DiscordMessagePayload {
            message_id: Snowflake::new(msg.id.to_string())
                .unwrap_or_else(|_| panic!("Invalid message ID")),
            channel_id: Snowflake::new(msg.channel_id.to_string())
                .unwrap_or_else(|_| panic!("Invalid channel ID")),
            guild_id: msg
                .guild_id
                .and_then(|id| Snowflake::new(id.to_string()).ok()),
            author_id: Snowflake::new(msg.author.id.to_string())
                .unwrap_or_else(|_| panic!("Invalid author ID")),
            author_name: msg.author.name.clone(),
            content: msg.content.clone(),
            timestamp: msg
                .timestamp
                .to_rfc3339()
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            is_bot: msg.author.bot,
            attachments: msg
                .attachments
                .iter()
                .filter_map(|a| {
                    Some(crate::types::DiscordAttachment {
                        id: Snowflake::new(a.id.to_string()).ok()?,
                        filename: a.filename.clone(),
                        size: a.size as u64,
                        url: a.url.clone(),
                        proxy_url: a.proxy_url.clone(),
                        content_type: a.content_type.clone(),
                        height: a.height,
                        width: a.width,
                    })
                })
                .collect(),
            embeds: msg
                .embeds
                .iter()
                .map(|e| crate::types::DiscordEmbed {
                    title: e.title.clone(),
                    description: e.description.clone(),
                    url: e.url.clone(),
                    timestamp: e.timestamp.and_then(|t| t.to_rfc3339()),
                    color: e.colour.map(|c| c.0),
                    footer: e.footer.as_ref().map(|f| crate::types::DiscordEmbedFooter {
                        text: f.text.clone(),
                        icon_url: f.icon_url.clone(),
                    }),
                    image: e.image.as_ref().map(|i| crate::types::DiscordEmbedMedia {
                        url: i.url.clone(),
                        proxy_url: i.proxy_url.clone(),
                        height: i.height,
                        width: i.width,
                    }),
                    thumbnail: e
                        .thumbnail
                        .as_ref()
                        .map(|t| crate::types::DiscordEmbedMedia {
                            url: t.url.clone(),
                            proxy_url: t.proxy_url.clone(),
                            height: t.height,
                            width: t.width,
                        }),
                    author: e.author.as_ref().map(|a| crate::types::DiscordEmbedAuthor {
                        name: a.name.clone(),
                        url: a.url.clone(),
                        icon_url: a.icon_url.clone(),
                    }),
                    fields: e
                        .fields
                        .iter()
                        .map(|f| crate::types::DiscordEmbedField {
                            name: f.name.clone(),
                            value: f.value.clone(),
                            inline: f.inline,
                        })
                        .collect(),
                })
                .collect(),
            mentions: msg
                .mentions
                .iter()
                .filter_map(|u| Snowflake::new(u.id.to_string()).ok())
                .collect(),
        };

        let state = self.state.read().await;
        if let Some(ref callback) = state.event_callback {
            callback(
                DiscordEventType::MessageReceived,
                serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null),
            );
        }
    }

    async fn guild_member_addition(&self, _ctx: Context, member: Member) {
        let payload = DiscordMemberPayload {
            user_id: Snowflake::new(member.user.id.to_string())
                .unwrap_or_else(|_| panic!("Invalid user ID")),
            username: member.user.name.clone(),
            display_name: member.nick.clone(),
            guild_id: Snowflake::new(member.guild_id.to_string())
                .unwrap_or_else(|_| panic!("Invalid guild ID")),
            roles: member
                .roles
                .iter()
                .filter_map(|r| Snowflake::new(r.to_string()).ok())
                .collect(),
            joined_at: member.joined_at.and_then(|t| t.to_rfc3339()),
        };

        let state = self.state.read().await;
        if let Some(ref callback) = state.event_callback {
            callback(
                DiscordEventType::EntityJoined,
                serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null),
            );
        }
    }

    async fn guild_member_removal(
        &self,
        _ctx: Context,
        guild_id: GuildId,
        user: serenity::model::prelude::User,
        _member: Option<Member>,
    ) {
        let payload = DiscordMemberPayload {
            user_id: Snowflake::new(user.id.to_string())
                .unwrap_or_else(|_| panic!("Invalid user ID")),
            username: user.name.clone(),
            display_name: None,
            guild_id: Snowflake::new(guild_id.to_string())
                .unwrap_or_else(|_| panic!("Invalid guild ID")),
            roles: Vec::new(),
            joined_at: None,
        };

        let state = self.state.read().await;
        if let Some(ref callback) = state.event_callback {
            callback(
                DiscordEventType::EntityLeft,
                serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null),
            );
        }
    }

    async fn voice_state_update(&self, _ctx: Context, _old: Option<VoiceState>, new: VoiceState) {
        let guild_id = match new.guild_id {
            Some(id) => id,
            None => return,
        };

        let payload = DiscordVoiceStatePayload {
            user_id: Snowflake::new(new.user_id.to_string())
                .unwrap_or_else(|_| panic!("Invalid user ID")),
            guild_id: Snowflake::new(guild_id.to_string())
                .unwrap_or_else(|_| panic!("Invalid guild ID")),
            channel_id: new
                .channel_id
                .and_then(|id| Snowflake::new(id.to_string()).ok()),
            session_id: new.session_id.clone(),
            is_muted: new.mute,
            is_deafened: new.deaf,
            is_self_muted: new.self_mute,
            is_self_deafened: new.self_deaf,
            is_streaming: new.self_stream.unwrap_or(false),
            is_video_on: new.self_video,
        };

        let state = self.state.read().await;
        if let Some(ref callback) = state.event_callback {
            callback(
                DiscordEventType::VoiceStateChanged,
                serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null),
            );
        }
    }
}

/// High-level Discord client/service wrapper.
///
/// Manages the Serenity client lifecycle and exposes helpers for sending messages and querying
/// guild information.
pub struct DiscordService {
    config: DiscordConfig,
    state: Arc<RwLock<ServiceState>>,
    client: Arc<RwLock<Option<Client>>>,
    http: Arc<RwLock<Option<Arc<serenity::http::Http>>>>,
}

impl DiscordService {
    /// Create a new service instance with the provided configuration.
    pub fn new(config: DiscordConfig) -> Self {
        Self {
            config,
            state: Arc::new(RwLock::new(ServiceState::default())),
            client: Arc::new(RwLock::new(None)),
            http: Arc::new(RwLock::new(None)),
        }
    }

    /// Return the configuration used by this service.
    pub fn config(&self) -> &DiscordConfig {
        &self.config
    }

    /// Check if the service is running
    pub async fn is_running(&self) -> bool {
        self.state.read().await.is_running
    }

    /// Set the event callback
    pub fn set_event_callback<F>(&mut self, callback: F)
    where
        F: Fn(DiscordEventType, serde_json::Value) + Send + Sync + 'static,
    {
        // We need to update state in a sync context, so use try_write
        // This is safe because we're the only ones who could be writing during setup
        if let Ok(mut state) = self.state.try_write() {
            state.event_callback = Some(Box::new(callback));
        }
    }

    /// Start the Discord service
    pub async fn start(&mut self) -> Result<()> {
        // Check if already running
        {
            let state = self.state.read().await;
            if state.is_running {
                return Err(DiscordError::AlreadyRunning);
            }
        }

        // Validate config
        self.config.validate()?;

        info!("Starting Discord service...");

        let intents = GatewayIntents::GUILDS
            | GatewayIntents::GUILD_MESSAGES
            | GatewayIntents::MESSAGE_CONTENT
            | GatewayIntents::DIRECT_MESSAGES
            | GatewayIntents::GUILD_VOICE_STATES
            | GatewayIntents::GUILD_MESSAGE_REACTIONS
            | GatewayIntents::GUILD_MEMBERS;

        let handler = DiscordEventHandler {
            config: self.config.clone(),
            state: self.state.clone(),
        };

        let client = Client::builder(&self.config.token, intents)
            .event_handler(handler)
            .await
            .map_err(|e| DiscordError::ConnectionFailed(e.to_string()))?;

        // Store HTTP client for sending messages
        {
            let mut http_lock = self.http.write().await;
            *http_lock = Some(client.http.clone());
        }

        // Store client
        {
            let mut client_lock = self.client.write().await;
            *client_lock = Some(client);
        }

        // Mark as running
        {
            let mut state = self.state.write().await;
            state.is_running = true;
        }

        // Start client in background
        let client_clone = self.client.clone();
        let state_clone = self.state.clone();
        tokio::spawn(async move {
            if let Some(mut client) = client_clone.write().await.take() {
                if let Err(why) = client.start().await {
                    error!("Client error: {:?}", why);
                    let mut state = state_clone.write().await;
                    state.is_running = false;
                }
            }
        });

        info!("Discord service started successfully");
        Ok(())
    }

    /// Stop the Discord service
    pub async fn stop(&mut self) -> Result<()> {
        info!("Stopping Discord service...");

        // Take the client and shut it down
        if let Some(client) = self.client.write().await.take() {
            client.shard_manager.shutdown_all().await;
        }

        // Clear HTTP client
        {
            let mut http_lock = self.http.write().await;
            *http_lock = None;
        }

        // Mark as not running
        {
            let mut state = self.state.write().await;
            state.is_running = false;
        }

        info!("Discord service stopped");
        Ok(())
    }

    /// Send a message to a channel
    pub async fn send_message(&self, channel_id: &Snowflake, content: &str) -> Result<Snowflake> {
        let http = self
            .http
            .read()
            .await
            .clone()
            .ok_or(DiscordError::ClientNotInitialized)?;

        let channel = ChannelId::new(channel_id.as_u64());

        // Split message if too long
        let parts = split_message(content);

        let mut last_message_id = None;
        for part in parts {
            let msg = channel
                .say(&http, &part)
                .await
                .map_err(|e| DiscordError::ConnectionFailed(e.to_string()))?;
            last_message_id = Some(msg.id);
        }

        let message_id = last_message_id.ok_or_else(|| {
            DiscordError::InvalidArgument("No message content provided".to_string())
        })?;

        Ok(Snowflake::new(message_id.to_string())
            .unwrap_or_else(|_| panic!("Invalid message ID from Discord")))
    }

    /// Send a direct message to a user
    pub async fn send_dm(&self, user_id: &Snowflake, content: &str) -> Result<Snowflake> {
        let http = self
            .http
            .read()
            .await
            .clone()
            .ok_or(DiscordError::ClientNotInitialized)?;

        let user = UserId::new(user_id.as_u64());
        let dm_channel = user
            .create_dm_channel(&http)
            .await
            .map_err(|e| DiscordError::ConnectionFailed(e.to_string()))?;

        // Split message if too long
        let parts = split_message(content);

        let mut last_message_id = None;
        for part in parts {
            let msg = dm_channel
                .say(&http, &part)
                .await
                .map_err(|e| DiscordError::ConnectionFailed(e.to_string()))?;
            last_message_id = Some(msg.id);
        }

        let message_id = last_message_id.ok_or_else(|| {
            DiscordError::InvalidArgument("No message content provided".to_string())
        })?;

        Ok(Snowflake::new(message_id.to_string())
            .unwrap_or_else(|_| panic!("Invalid message ID from Discord")))
    }

    /// Reply to a message
    pub async fn reply_to_message(
        &self,
        channel_id: &Snowflake,
        message_id: &Snowflake,
        content: &str,
    ) -> Result<Snowflake> {
        let http = self
            .http
            .read()
            .await
            .clone()
            .ok_or(DiscordError::ClientNotInitialized)?;

        let channel = ChannelId::new(channel_id.as_u64());
        let msg_ref = MessageId::new(message_id.as_u64());

        // Split message if too long
        let parts = split_message(content);

        let mut last_message_id = None;
        for (i, part) in parts.iter().enumerate() {
            let msg = if i == 0 {
                // First message is a reply
                channel
                    .send_message(
                        &http,
                        serenity::builder::CreateMessage::new()
                            .content(part)
                            .reference_message((channel, msg_ref)),
                    )
                    .await
                    .map_err(|e| DiscordError::ConnectionFailed(e.to_string()))?
            } else {
                // Subsequent messages are normal
                channel
                    .say(&http, part)
                    .await
                    .map_err(|e| DiscordError::ConnectionFailed(e.to_string()))?
            };
            last_message_id = Some(msg.id);
        }

        let message_id = last_message_id.ok_or_else(|| {
            DiscordError::InvalidArgument("No message content provided".to_string())
        })?;

        Ok(Snowflake::new(message_id.to_string())
            .unwrap_or_else(|_| panic!("Invalid message ID from Discord")))
    }

    /// Add a reaction to a message
    pub async fn add_reaction(
        &self,
        channel_id: &Snowflake,
        message_id: &Snowflake,
        emoji: &str,
    ) -> Result<()> {
        let http = self
            .http
            .read()
            .await
            .clone()
            .ok_or(DiscordError::ClientNotInitialized)?;

        let channel = ChannelId::new(channel_id.as_u64());
        let msg_id = MessageId::new(message_id.as_u64());

        // Parse emoji - could be unicode or custom format
        let reaction_type = if emoji.starts_with('<') && emoji.ends_with('>') {
            // Custom emoji format: <:name:id> or <a:name:id>
            serenity::model::channel::ReactionType::try_from(emoji)
                .map_err(|e| DiscordError::InvalidArgument(format!("Invalid emoji: {}", e)))?
        } else {
            // Unicode emoji
            serenity::model::channel::ReactionType::Unicode(emoji.to_string())
        };

        channel
            .create_reaction(&http, msg_id, reaction_type)
            .await
            .map_err(|e| DiscordError::ConnectionFailed(e.to_string()))?;

        Ok(())
    }

    // ========================================================================
    // Stub methods for actions - TODO: implement with actual functionality
    // ========================================================================

    /// Get list of allowed channel IDs
    #[allow(dead_code)]
    pub fn get_allowed_channels(&self) -> Vec<String> {
        self.config.channel_ids.clone()
    }

    /// Check if channels are configured via environment
    #[allow(dead_code)]
    pub fn has_env_channels(&self) -> bool {
        !self.config.channel_ids.is_empty()
    }

    /// Get channel info by ID
    #[allow(dead_code)]
    pub async fn get_channel_info(&self, channel_id: &str) -> Result<Option<serde_json::Value>> {
        let http = self
            .http
            .read()
            .await
            .clone()
            .ok_or(DiscordError::ClientNotInitialized)?;

        let channel = ChannelId::new(
            channel_id
                .parse::<u64>()
                .map_err(|_| DiscordError::InvalidArgument("Invalid channel ID".to_string()))?,
        );

        match channel.to_channel(&http).await {
            Ok(channel_obj) => {
                if let Some(guild_channel) = channel_obj.guild() {
                    Ok(Some(serde_json::json!({
                        "id": guild_channel.id.to_string(),
                        "name": guild_channel.name,
                        "type": format!("{:?}", guild_channel.kind),
                    })))
                } else {
                    Ok(None)
                }
            }
            Err(_) => Ok(None),
        }
    }

    /// Extract message reference from text (message ID or link)
    #[allow(dead_code)]
    pub async fn extract_message_reference(&self, text: &str) -> Result<Option<String>> {
        // Check for message link format
        let link_pattern = regex::Regex::new(r"discord\.com/channels/\d+/\d+/(\d+)")
            .map_err(|e| DiscordError::InvalidArgument(e.to_string()))?;

        if let Some(caps) = link_pattern.captures(text) {
            return Ok(caps.get(1).map(|m| m.as_str().to_string()));
        }

        // Check for raw message ID
        let id_pattern = regex::Regex::new(r"\b(\d{17,20})\b")
            .map_err(|e| DiscordError::InvalidArgument(e.to_string()))?;

        Ok(id_pattern.find(text).map(|m| m.as_str().to_string()))
    }

    /// Check if bot has manage messages permission in channel
    #[allow(dead_code)]
    pub async fn has_manage_messages_permission(&self, _channel_id: &Snowflake) -> bool {
        // TODO: Implement proper permission checking
        true
    }

    /// Find a message by reference (ID or search term)
    #[allow(dead_code)]
    pub async fn find_message(
        &self,
        channel_id: &Snowflake,
        message_ref: &str,
    ) -> Result<Option<serde_json::Value>> {
        let http = self
            .http
            .read()
            .await
            .clone()
            .ok_or(DiscordError::ClientNotInitialized)?;

        let channel = ChannelId::new(channel_id.as_u64());

        // Try to parse as message ID
        if let Ok(msg_id) = message_ref.parse::<u64>() {
            match channel.message(&http, MessageId::new(msg_id)).await {
                Ok(msg) => {
                    return Ok(Some(serde_json::json!({
                        "id": msg.id.to_string(),
                        "author": {
                            "username": msg.author.name,
                            "id": msg.author.id.to_string(),
                        },
                        "content": msg.content,
                        "pinned": msg.pinned,
                        "timestamp": msg.timestamp.to_rfc3339().unwrap_or_default(),
                    })));
                }
                Err(_) => return Ok(None),
            }
        }

        Ok(None)
    }

    /// Pin a message
    #[allow(dead_code)]
    pub async fn pin_message(&self, channel_id: &Snowflake, message_id: &str) -> Result<bool> {
        let http = self
            .http
            .read()
            .await
            .clone()
            .ok_or(DiscordError::ClientNotInitialized)?;

        let channel = ChannelId::new(channel_id.as_u64());
        let msg_id = MessageId::new(
            message_id
                .parse::<u64>()
                .map_err(|_| DiscordError::InvalidArgument("Invalid message ID".to_string()))?,
        );

        channel
            .pin(&http, msg_id)
            .await
            .map_err(|e| DiscordError::ConnectionFailed(e.to_string()))?;

        Ok(true)
    }

    /// Unpin a message
    #[allow(dead_code)]
    pub async fn unpin_message(&self, channel_id: &Snowflake, message_id: &str) -> Result<bool> {
        let http = self
            .http
            .read()
            .await
            .clone()
            .ok_or(DiscordError::ClientNotInitialized)?;

        let channel = ChannelId::new(channel_id.as_u64());
        let msg_id = MessageId::new(
            message_id
                .parse::<u64>()
                .map_err(|_| DiscordError::InvalidArgument("Invalid message ID".to_string()))?,
        );

        channel
            .unpin(&http, msg_id)
            .await
            .map_err(|e| DiscordError::ConnectionFailed(e.to_string()))?;

        Ok(true)
    }

    /// Extract reaction info (emoji and message reference) from text
    #[allow(dead_code)]
    pub async fn extract_reaction_info(&self, text: &str) -> Result<Option<serde_json::Value>> {
        // Look for emoji patterns
        let emoji_pattern = regex::Regex::new(r"(<:[a-zA-Z0-9_]+:\d+>|[\p{Emoji}])")
            .map_err(|e| DiscordError::InvalidArgument(e.to_string()))?;

        let emoji = emoji_pattern.find(text).map(|m| m.as_str().to_string());

        // Look for message reference
        let message_ref = self.extract_message_reference(text).await?;

        if emoji.is_some() || message_ref.is_some() {
            Ok(Some(serde_json::json!({
                "emoji": emoji,
                "message_ref": message_ref,
            })))
        } else {
            Ok(None)
        }
    }

    /// Parse read channel request info
    #[allow(dead_code)]
    pub async fn parse_read_channel_info(&self, text: &str) -> Result<serde_json::Value> {
        let channel_info = self.parse_channel_info(text).await?;

        // Extract message count if specified
        let count_pattern = regex::Regex::new(r"(\d+)\s*(?:messages?|msgs?)")
            .map_err(|e| DiscordError::InvalidArgument(e.to_string()))?;

        let message_count = count_pattern
            .captures(text)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse::<u32>().ok())
            .unwrap_or(50);

        Ok(serde_json::json!({
            "channel_identifier": channel_info.get("channel_identifier"),
            "is_voice_channel": channel_info.get("is_voice_channel"),
            "message_count": message_count,
        }))
    }

    /// Search messages in channel
    #[allow(dead_code)]
    pub async fn search_messages(
        &self,
        _channel_id: &str,
        _query: &str,
        _author: Option<&str>,
        _limit: u32,
    ) -> Result<Vec<serde_json::Value>> {
        // TODO: Implement message search - Discord doesn't have a native search API for bots
        Ok(vec![])
    }

    /// Parse search criteria from text
    #[allow(dead_code)]
    pub async fn parse_search_criteria(&self, text: &str) -> Result<serde_json::Value> {
        // Extract search terms
        let text_lower = text.to_lowercase();

        // Check for user filter
        let user_pattern = regex::Regex::new(r"from:?\s*<?@?(\w+)>?")
            .map_err(|e| DiscordError::InvalidArgument(e.to_string()))?;
        let from_user = user_pattern
            .captures(&text_lower)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());

        // Check for channel filter
        let channel_pattern = regex::Regex::new(r"in:?\s*<?#?(\w+)>?")
            .map_err(|e| DiscordError::InvalidArgument(e.to_string()))?;
        let in_channel = channel_pattern
            .captures(&text_lower)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());

        // Check for limit
        let limit_pattern = regex::Regex::new(r"(?:limit|max):?\s*(\d+)")
            .map_err(|e| DiscordError::InvalidArgument(e.to_string()))?;
        let limit = limit_pattern
            .captures(&text_lower)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse::<u32>().ok())
            .unwrap_or(25);

        // Extract the main search query (remove filter terms)
        let mut query = text.to_string();
        if let Some(m) = user_pattern.find(&query) {
            query = query.replace(m.as_str(), "");
        }
        if let Some(m) = channel_pattern.find(&query) {
            query = query.replace(m.as_str(), "");
        }
        if let Some(m) = limit_pattern.find(&query) {
            query = query.replace(m.as_str(), "");
        }

        Ok(serde_json::json!({
            "query": query.trim(),
            "from_user": from_user,
            "in_channel": in_channel,
            "limit": limit,
        }))
    }

    /// Get server info
    #[allow(dead_code)]
    pub async fn get_server_info(&self, guild_id: &str) -> Result<serde_json::Value> {
        let snowflake = Snowflake::new(guild_id.to_string())?;
        let info = self.get_guild_info(&snowflake).await?;

        Ok(serde_json::json!({
            "id": info.guild_id.as_str(),
            "name": info.guild_name,
            "member_count": info.member_count,
            "text_channels": info.text_channels.len(),
            "voice_channels": info.voice_channels.len(),
        }))
    }

    /// Transcribe media from URL (stub - requires whisper/similar)
    #[allow(dead_code)]
    pub async fn transcribe_media(&self, _url: &str) -> Result<String> {
        // TODO: Implement media transcription with whisper or similar
        Ok("Transcription requires external service integration.".to_string())
    }

    /// Parse summary request parameters from text
    #[allow(dead_code)]
    pub async fn parse_summary_request(&self, _text: &str) -> Result<serde_json::Value> {
        // TODO: Implement NLP parsing for summary parameters
        Ok(serde_json::json!({ "message_count": 50 }))
    }

    /// Fetch recent messages from a channel
    #[allow(dead_code)]
    pub async fn fetch_channel_messages(
        &self,
        channel_id: &str,
        limit: u32,
    ) -> Result<Vec<serde_json::Value>> {
        let http = self
            .http
            .read()
            .await
            .clone()
            .ok_or(DiscordError::ClientNotInitialized)?;

        let channel = ChannelId::new(
            channel_id
                .parse::<u64>()
                .map_err(|_| DiscordError::InvalidArgument("Invalid channel ID".to_string()))?,
        );

        let messages = channel
            .messages(
                &http,
                serenity::builder::GetMessages::new().limit(limit as u8),
            )
            .await
            .map_err(|e| DiscordError::ConnectionFailed(e.to_string()))?;

        Ok(messages
            .iter()
            .map(|msg| {
                serde_json::json!({
                    "id": msg.id.to_string(),
                    "author": msg.author.name,
                    "content": msg.content,
                    "timestamp": msg.timestamp.to_rfc3339().unwrap_or_default(),
                })
            })
            .collect())
    }

    /// Generate a summary using LLM (stub - requires model integration)
    #[allow(dead_code)]
    pub async fn generate_summary(&self, _content: &str, _prompt: &str) -> Result<String> {
        // TODO: Integrate with LLM service for actual summarization
        Ok("Summary generation requires LLM integration.".to_string())
    }

    /// Parse poll information from text
    #[allow(dead_code)]
    pub async fn parse_poll_info(&self, _text: &str) -> Result<Option<serde_json::Value>> {
        // TODO: Implement NLP parsing for poll parameters
        Ok(None)
    }

    /// Send a poll message with reaction emojis
    #[allow(dead_code)]
    pub async fn send_poll(
        &self,
        channel_id: &Snowflake,
        content: &str,
        emojis: &[&str],
    ) -> Result<Option<String>> {
        let message_id = self.send_message(channel_id, content).await?;

        // Add reaction emojis
        for emoji in emojis {
            self.add_reaction(channel_id, &message_id, emoji).await?;
        }

        Ok(Some(message_id.as_str().to_string()))
    }

    /// Extract media URL from text
    #[allow(dead_code)]
    pub async fn extract_media_url(&self, text: &str) -> Result<Option<String>> {
        // Simple URL extraction using regex pattern
        let url_pattern = regex::Regex::new(r"https?://[^\s]+")
            .map_err(|e| DiscordError::InvalidArgument(e.to_string()))?;

        Ok(url_pattern.find(text).map(|m| m.as_str().to_string()))
    }

    /// Download media from URL (stub - requires external tooling)
    #[allow(dead_code)]
    pub async fn download_media(&self, _url: &str) -> Result<Option<serde_json::Value>> {
        // TODO: Implement media download with yt-dlp or similar
        Ok(None)
    }

    /// Send a file to a channel
    #[allow(dead_code)]
    pub async fn send_file(
        &self,
        channel_id: &Snowflake,
        file_path: &str,
        message: &str,
    ) -> Result<Snowflake> {
        let http = self
            .http
            .read()
            .await
            .clone()
            .ok_or(DiscordError::ClientNotInitialized)?;

        let channel = ChannelId::new(channel_id.as_u64());

        let attachment = serenity::builder::CreateAttachment::path(file_path)
            .await
            .map_err(|e| DiscordError::InvalidArgument(e.to_string()))?;

        let msg = channel
            .send_message(
                &http,
                serenity::builder::CreateMessage::new()
                    .content(message)
                    .add_file(attachment),
            )
            .await
            .map_err(|e| DiscordError::ConnectionFailed(e.to_string()))?;

        Ok(Snowflake::new(msg.id.to_string())
            .unwrap_or_else(|_| panic!("Invalid message ID from Discord")))
    }

    /// Extract user identifier from text
    #[allow(dead_code)]
    pub async fn extract_user_identifier(&self, text: &str) -> Result<Option<String>> {
        // Check for mention format <@USER_ID>
        let mention_pattern = regex::Regex::new(r"<@!?(\d+)>")
            .map_err(|e| DiscordError::InvalidArgument(e.to_string()))?;

        if let Some(caps) = mention_pattern.captures(text) {
            return Ok(caps.get(1).map(|m| m.as_str().to_string()));
        }

        // Check for username#discriminator or just username
        let words: Vec<&str> = text.split_whitespace().collect();
        for word in words {
            if word.contains('#') || word.starts_with('@') {
                return Ok(Some(word.trim_start_matches('@').to_string()));
            }
        }

        Ok(None)
    }

    /// Get member info from guild
    #[allow(dead_code)]
    pub async fn get_member_info(
        &self,
        guild_id: &str,
        user_identifier: &str,
    ) -> Result<Option<serde_json::Value>> {
        let http = self
            .http
            .read()
            .await
            .clone()
            .ok_or(DiscordError::ClientNotInitialized)?;

        let guild = GuildId::new(
            guild_id
                .parse::<u64>()
                .map_err(|_| DiscordError::InvalidArgument("Invalid guild ID".to_string()))?,
        );

        // Try to parse as user ID first
        if let Ok(user_id) = user_identifier.parse::<u64>() {
            let member = guild
                .member(&http, UserId::new(user_id))
                .await
                .map_err(|e| DiscordError::ConnectionFailed(e.to_string()))?;

            return Ok(Some(serde_json::json!({
                "id": member.user.id.to_string(),
                "username": member.user.name,
                "display_name": member.nick,
                "roles": member.roles.iter().map(|r| r.to_string()).collect::<Vec<_>>(),
                "joined_at": member.joined_at.and_then(|t| t.to_rfc3339()),
            })));
        }

        // Search by username (limited functionality)
        Ok(None)
    }

    /// Format user info for display
    #[allow(dead_code)]
    pub fn format_user_info(&self, user_info: &serde_json::Value) -> String {
        let username = user_info
            .get("username")
            .and_then(|u| u.as_str())
            .unwrap_or("Unknown");
        let display_name = user_info.get("display_name").and_then(|d| d.as_str());
        let joined_at = user_info.get("joined_at").and_then(|j| j.as_str());

        let mut info = format!("👤 **{}**", username);
        if let Some(nick) = display_name {
            info.push_str(&format!(" ({})", nick));
        }
        if let Some(joined) = joined_at {
            info.push_str(&format!("\n📅 Joined: {}", joined));
        }
        info
    }

    /// Parse channel info from text
    #[allow(dead_code)]
    pub async fn parse_channel_info(&self, text: &str) -> Result<serde_json::Value> {
        // Check for channel mention format <#CHANNEL_ID>
        let channel_pattern = regex::Regex::new(r"<#(\d+)>")
            .map_err(|e| DiscordError::InvalidArgument(e.to_string()))?;

        if let Some(caps) = channel_pattern.captures(text) {
            if let Some(id) = caps.get(1) {
                return Ok(serde_json::json!({
                    "channel_identifier": id.as_str(),
                    "is_voice_channel": false,
                }));
            }
        }

        // Check for voice keywords
        let text_lower = text.to_lowercase();
        let is_voice = text_lower.contains("voice") || text_lower.contains("vc");

        // Try to extract channel name
        let words: Vec<&str> = text.split_whitespace().collect();
        for word in &words {
            if word.starts_with('#') {
                return Ok(serde_json::json!({
                    "channel_identifier": word.trim_start_matches('#'),
                    "is_voice_channel": is_voice,
                }));
            }
        }

        Ok(serde_json::json!({
            "channel_identifier": "",
            "is_voice_channel": is_voice,
        }))
    }

    /// Find a channel by identifier
    #[allow(dead_code)]
    pub async fn find_channel(
        &self,
        identifier: &str,
        guild_id: Option<&str>,
        is_voice: bool,
    ) -> Result<serde_json::Value> {
        let http = self
            .http
            .read()
            .await
            .clone()
            .ok_or(DiscordError::ClientNotInitialized)?;

        let guild_id = match guild_id {
            Some(id) => id
                .parse::<u64>()
                .map_err(|_| DiscordError::InvalidArgument("Invalid guild ID".to_string()))?,
            None => return Ok(serde_json::Value::Null),
        };

        let guild = GuildId::new(guild_id);
        let channels = guild
            .channels(&http)
            .await
            .map_err(|e| DiscordError::ConnectionFailed(e.to_string()))?;

        // Try to find by ID first
        if let Ok(channel_id) = identifier.parse::<u64>() {
            if let Some((_, channel)) = channels.iter().find(|(id, _)| id.get() == channel_id) {
                let channel_type = match channel.kind {
                    serenity::model::channel::ChannelType::Voice
                    | serenity::model::channel::ChannelType::Stage => "voice",
                    _ => "text",
                };
                return Ok(serde_json::json!({
                    "id": channel.id.to_string(),
                    "name": channel.name,
                    "type": channel_type,
                }));
            }
        }

        // Search by name
        for (_, channel) in channels {
            let is_voice_channel = matches!(
                channel.kind,
                serenity::model::channel::ChannelType::Voice
                    | serenity::model::channel::ChannelType::Stage
            );

            if channel.name.to_lowercase() == identifier.to_lowercase()
                && is_voice_channel == is_voice
            {
                let channel_type = if is_voice_channel { "voice" } else { "text" };
                return Ok(serde_json::json!({
                    "id": channel.id.to_string(),
                    "name": channel.name,
                    "type": channel_type,
                }));
            }
        }

        Ok(serde_json::Value::Null)
    }

    /// Join a voice channel (stub - requires voice gateway integration)
    #[allow(dead_code)]
    pub async fn join_voice_channel(&self, _channel_id: &str) -> Result<bool> {
        // TODO: Implement voice channel joining with songbird or similar
        Ok(false)
    }

    /// Leave current voice channel (stub)
    #[allow(dead_code)]
    pub async fn leave_voice_channel(&self) -> Result<bool> {
        // TODO: Implement voice channel leaving
        Ok(false)
    }

    /// Add a channel to the allowed list
    #[allow(dead_code)]
    pub async fn add_allowed_channel(&self, _channel_id: &str) -> Result<bool> {
        // TODO: Implement dynamic channel allowlist management
        Ok(true)
    }

    /// Remove a channel from the allowed list
    #[allow(dead_code)]
    pub async fn remove_allowed_channel(&self, _channel_id: &str) -> Result<bool> {
        // TODO: Implement dynamic channel allowlist management
        Ok(true)
    }

    // ========================================================================
    // End stub methods
    // ========================================================================

    /// Get guild information
    pub async fn get_guild_info(&self, guild_id: &Snowflake) -> Result<DiscordWorldPayload> {
        let http = self
            .http
            .read()
            .await
            .clone()
            .ok_or(DiscordError::ClientNotInitialized)?;

        let guild = GuildId::new(guild_id.as_u64());
        let guild_info = guild
            .to_partial_guild(&http)
            .await
            .map_err(|e| DiscordError::GuildNotFound(e.to_string()))?;

        let channels = guild
            .channels(&http)
            .await
            .map_err(|e| DiscordError::ConnectionFailed(e.to_string()))?;

        let mut text_channels = Vec::new();
        let mut voice_channels = Vec::new();

        for (id, channel) in channels {
            let channel_info = DiscordChannelInfo {
                id: Snowflake::new(id.to_string()).unwrap_or_else(|_| panic!("Invalid channel ID")),
                name: channel.name.clone(),
                channel_type: match channel.kind {
                    serenity::model::channel::ChannelType::Text => DiscordChannelType::Text,
                    serenity::model::channel::ChannelType::Voice => DiscordChannelType::Voice,
                    serenity::model::channel::ChannelType::Category => DiscordChannelType::Category,
                    serenity::model::channel::ChannelType::News => DiscordChannelType::Announcement,
                    serenity::model::channel::ChannelType::Stage => DiscordChannelType::Stage,
                    serenity::model::channel::ChannelType::Forum => DiscordChannelType::Forum,
                    _ => DiscordChannelType::Text,
                },
            };

            match channel.kind {
                serenity::model::channel::ChannelType::Voice
                | serenity::model::channel::ChannelType::Stage => {
                    voice_channels.push(channel_info);
                }
                _ => {
                    text_channels.push(channel_info);
                }
            }
        }

        Ok(DiscordWorldPayload {
            guild_id: Snowflake::new(guild_id.as_str().to_string())
                .unwrap_or_else(|_| panic!("Invalid guild ID")),
            guild_name: guild_info.name,
            member_count: guild_info.approximate_member_count.unwrap_or(0) as u32,
            text_channels,
            voice_channels,
        })
    }
}

/// Split a message into chunks that fit within Discord's limit
pub fn split_message(content: &str) -> Vec<String> {
    if content.len() <= MAX_MESSAGE_LENGTH {
        return vec![content.to_string()];
    }

    let mut parts = Vec::new();
    let mut current = String::new();

    for line in content.lines() {
        // Check if adding this line would exceed limit
        let line_with_newline = if current.is_empty() {
            line.to_string()
        } else {
            format!("\n{}", line)
        };

        if current.len() + line_with_newline.len() > MAX_MESSAGE_LENGTH {
            // If current is not empty, push it
            if !current.is_empty() {
                parts.push(current);
                current = String::new();
            }

            // If the line itself is too long, split by words
            if line.len() > MAX_MESSAGE_LENGTH {
                let words: Vec<&str> = line.split_whitespace().collect();
                for word in words {
                    let word_with_space = if current.is_empty() {
                        word.to_string()
                    } else {
                        format!(" {}", word)
                    };

                    if current.len() + word_with_space.len() > MAX_MESSAGE_LENGTH {
                        if !current.is_empty() {
                            parts.push(current);
                            current = String::new();
                        }

                        // If single word is too long, split by characters
                        if word.len() > MAX_MESSAGE_LENGTH {
                            let chars: Vec<char> = word.chars().collect();
                            for chunk in chars.chunks(MAX_MESSAGE_LENGTH) {
                                parts.push(chunk.iter().collect());
                            }
                        } else {
                            current = word.to_string();
                        }
                    } else {
                        current.push_str(&word_with_space);
                    }
                }
            } else {
                current = line.to_string();
            }
        } else {
            current.push_str(&line_with_newline);
        }
    }

    // Don't forget the last part
    if !current.is_empty() {
        parts.push(current);
    }

    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_message_short() {
        let msg = "Hello, world!";
        let parts = split_message(msg);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0], msg);
    }

    #[test]
    fn test_split_message_long() {
        let msg = "a".repeat(MAX_MESSAGE_LENGTH + 500);
        let parts = split_message(&msg);
        assert!(parts.len() > 1);
        for part in &parts {
            assert!(part.len() <= MAX_MESSAGE_LENGTH);
        }
    }

    #[test]
    fn test_split_message_multiline() {
        let lines: Vec<String> = (0..100)
            .map(|i| format!("Line {}: Some content here", i))
            .collect();
        let msg = lines.join("\n");
        let parts = split_message(&msg);
        for part in &parts {
            assert!(part.len() <= MAX_MESSAGE_LENGTH);
        }
    }

    #[test]
    fn test_service_creation() {
        let config = DiscordConfig::new("test_token".to_string(), "123456789".to_string());
        let service = DiscordService::new(config);
        assert_eq!(service.config().token, "test_token");
    }
}
