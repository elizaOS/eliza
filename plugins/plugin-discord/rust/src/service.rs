//! Discord service implementation
//!
//! Provides the main DiscordService for connecting to Discord and handling events.

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

/// Maximum message length for Discord
pub const MAX_MESSAGE_LENGTH: usize = 2000;

/// Event callback type
pub type EventCallback = Box<dyn Fn(DiscordEventType, serde_json::Value) + Send + Sync>;

/// Discord service state
#[derive(Default)]
struct ServiceState {
    is_running: bool,
    event_callback: Option<EventCallback>,
}

/// Discord event handler for Serenity
struct DiscordEventHandler {
    config: DiscordConfig,
    state: Arc<RwLock<ServiceState>>,
}

#[async_trait]
impl EventHandler for DiscordEventHandler {
    async fn ready(&self, _ctx: Context, ready: Ready) {
        let discriminator = ready.user.discriminator
            .map(|d| d.to_string())
            .unwrap_or_else(|| "0".to_string());
        info!(
            "Discord bot connected as {}#{}",
            ready.user.name, discriminator
        );

        // Emit connected event
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
        // Skip if from self
        if msg.author.id == ctx.cache.current_user().id {
            return;
        }

        // Skip bot messages if configured
        if msg.author.bot && self.config.should_ignore_bot_messages {
            debug!("Ignoring bot message from {}", msg.author.name);
            return;
        }

        // Skip DMs if configured
        if msg.guild_id.is_none() && self.config.should_ignore_direct_messages {
            debug!("Ignoring DM from {}", msg.author.name);
            return;
        }

        // Check channel allowlist
        if !self.config.channel_ids.is_empty() {
            let channel_id_str = msg.channel_id.to_string();
            if !self.config.channel_ids.contains(&channel_id_str) {
                debug!("Ignoring message in non-allowed channel {}", channel_id_str);
                return;
            }
        }

        // Check if bot is mentioned (if respond only to mentions)
        if self.config.should_respond_only_to_mentions {
            let bot_id = ctx.cache.current_user().id;
            if !msg.mentions.iter().any(|u| u.id == bot_id) {
                debug!("Ignoring message without bot mention");
                return;
            }
        }

        // Build payload
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
            timestamp: msg.timestamp.to_rfc3339().unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
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
                    thumbnail: e.thumbnail.as_ref().map(|t| crate::types::DiscordEmbedMedia {
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

        // Emit event
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
            None => return, // DM voice calls not supported
        };

        let payload = DiscordVoiceStatePayload {
            user_id: Snowflake::new(new.user_id.to_string())
                .unwrap_or_else(|_| panic!("Invalid user ID")),
            guild_id: Snowflake::new(guild_id.to_string())
                .unwrap_or_else(|_| panic!("Invalid guild ID")),
            channel_id: new.channel_id.and_then(|id| Snowflake::new(id.to_string()).ok()),
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

/// Discord service for elizaOS
///
/// Manages connection to Discord and handles all Discord operations.
pub struct DiscordService {
    config: DiscordConfig,
    state: Arc<RwLock<ServiceState>>,
    client: Arc<RwLock<Option<Client>>>,
    http: Arc<RwLock<Option<Arc<serenity::http::Http>>>>,
}

impl DiscordService {
    /// Create a new Discord service
    pub fn new(config: DiscordConfig) -> Self {
        Self {
            config,
            state: Arc::new(RwLock::new(ServiceState::default())),
            client: Arc::new(RwLock::new(None)),
            http: Arc::new(RwLock::new(None)),
        }
    }

    /// Get the configuration
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
                    .send_message(&http, serenity::builder::CreateMessage::new()
                        .content(part)
                        .reference_message((channel, msg_ref)))
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
