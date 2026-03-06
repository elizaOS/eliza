//! iMessage service implementation

use crate::config::IMessageConfig;
use crate::error::{IMessageError, Result};
use crate::types::{
    format_phone_number, is_phone_number, split_message_for_imessage, IMessageChat,
    IMessageChatType, IMessageMessage, IMessageSendOptions, IMessageSendResult,
    MAX_IMESSAGE_MESSAGE_LENGTH,
};
use crate::IMESSAGE_SERVICE_NAME;
use async_trait::async_trait;
use elizaos::{IAgentRuntime, Service};
use std::process::Stdio;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

/// iMessage service for elizaOS
pub struct IMessageService {
    config: Arc<RwLock<Option<IMessageConfig>>>,
    connected: Arc<RwLock<bool>>,
    last_message_id: Arc<RwLock<Option<String>>>,
}

impl IMessageService {
    /// Creates a new service instance
    pub fn new() -> Self {
        Self {
            config: Arc::new(RwLock::new(None)),
            connected: Arc::new(RwLock::new(false)),
            last_message_id: Arc::new(RwLock::new(None)),
        }
    }

    /// Creates a service with the given configuration
    pub fn with_config(config: IMessageConfig) -> Result<Self> {
        config.validate()?;
        Ok(Self {
            config: Arc::new(RwLock::new(Some(config))),
            connected: Arc::new(RwLock::new(false)),
            last_message_id: Arc::new(RwLock::new(None)),
        })
    }

    /// Check if the service is connected
    pub async fn is_connected(&self) -> bool {
        *self.connected.read().await
    }

    /// Check if running on macOS
    pub fn is_macos() -> bool {
        cfg!(target_os = "macos")
    }

    /// Initialize the service
    pub async fn initialize(&self) -> Result<()> {
        if !Self::is_macos() {
            return Err(IMessageError::NotSupported);
        }

        let config = match IMessageConfig::from_env() {
            Ok(c) => c,
            Err(e) => {
                warn!("iMessage configuration not available: {}", e);
                return Err(e);
            }
        };

        if !config.enabled {
            info!("iMessage plugin is disabled via configuration");
            return Ok(());
        }

        // Validate Messages app is accessible
        self.validate_messages_access().await?;

        *self.config.write().await = Some(config);
        *self.connected.write().await = true;

        info!("iMessage service started");
        Ok(())
    }

    /// Stop the service
    pub async fn stop(&self) {
        *self.connected.write().await = false;
        *self.config.write().await = None;
        *self.last_message_id.write().await = None;
        info!("iMessage service stopped");
    }

    /// Send a message
    pub async fn send_message(
        &self,
        to: &str,
        text: &str,
        options: Option<IMessageSendOptions>,
    ) -> Result<IMessageSendResult> {
        let config = self.config.read().await;
        if config.is_none() {
            return Ok(IMessageSendResult::failure("Service not initialized"));
        }

        // Format phone number if needed
        let target = if is_phone_number(to) {
            format_phone_number(to)
        } else {
            to.to_string()
        };

        // Split message if too long
        let chunks = split_message_for_imessage(text, MAX_IMESSAGE_MESSAGE_LENGTH);

        for chunk in &chunks {
            let result = self.send_single_message(&target, chunk, options.as_ref()).await?;
            if !result.success {
                return Ok(result);
            }
        }

        Ok(IMessageSendResult::success(
            chrono::Utc::now().timestamp_millis().to_string(),
            target,
        ))
    }

    /// Get recent messages
    pub async fn get_recent_messages(&self, limit: usize) -> Result<Vec<IMessageMessage>> {
        let config = self.config.read().await;
        if config.is_none() {
            return Ok(Vec::new());
        }

        let script = format!(
            r#"tell application "Messages"
                set recentMessages to {{}}
                repeat with i from 1 to {}
                    try
                        set msg to item i of (get messages)
                        set msgText to text of msg
                        set msgSender to handle of sender of msg
                        set msgDate to date of msg
                        set end of recentMessages to {{msgText, msgSender, msgDate}}
                    end try
                end repeat
                return recentMessages
            end tell"#,
            limit
        );

        match self.run_applescript(&script).await {
            Ok(result) => Ok(self.parse_messages_result(&result)),
            Err(e) => {
                warn!("Failed to get recent messages: {}", e);
                Ok(Vec::new())
            }
        }
    }

    /// Get chats
    pub async fn get_chats(&self) -> Result<Vec<IMessageChat>> {
        let config = self.config.read().await;
        if config.is_none() {
            return Ok(Vec::new());
        }

        let script = r#"tell application "Messages"
            set chatList to {}
            repeat with c in chats
                set chatId to id of c
                set chatName to name of c
                set end of chatList to {chatId, chatName}
            end repeat
            return chatList
        end tell"#;

        match self.run_applescript(script).await {
            Ok(result) => Ok(self.parse_chats_result(&result)),
            Err(e) => {
                warn!("Failed to get chats: {}", e);
                Ok(Vec::new())
            }
        }
    }

    // Private methods

    async fn validate_messages_access(&self) -> Result<()> {
        self.run_applescript(r#"tell application "Messages" to return 1"#)
            .await
            .map_err(|_| {
                IMessageError::permission_denied(
                    "Cannot access Messages app. Ensure Full Disk Access is granted.",
                )
            })?;
        Ok(())
    }

    async fn send_single_message(
        &self,
        to: &str,
        text: &str,
        _options: Option<&IMessageSendOptions>,
    ) -> Result<IMessageSendResult> {
        // Try AppleScript
        self.send_via_applescript(to, text).await
    }

    async fn send_via_applescript(&self, to: &str, text: &str) -> Result<IMessageSendResult> {
        // Escape text for AppleScript
        let escaped_text = text.replace('\\', "\\\\").replace('"', "\\\"");

        let script = if to.starts_with("chat_id:") {
            let chat_id = &to[8..];
            format!(
                r#"tell application "Messages"
                    set targetChat to chat id "{}"
                    send "{}" to targetChat
                end tell"#,
                chat_id, escaped_text
            )
        } else {
            format!(
                r#"tell application "Messages"
                    set targetService to 1st account whose service type = iMessage
                    set targetBuddy to participant "{}" of targetService
                    send "{}" to targetBuddy
                end tell"#,
                to, escaped_text
            )
        };

        match self.run_applescript(&script).await {
            Ok(_) => Ok(IMessageSendResult::success(
                chrono::Utc::now().timestamp_millis().to_string(),
                to.to_string(),
            )),
            Err(e) => Ok(IMessageSendResult::failure(format!(
                "AppleScript error: {}",
                e
            ))),
        }
    }

    async fn run_applescript(&self, script: &str) -> Result<String> {
        #[cfg(not(target_os = "macos"))]
        return Err(IMessageError::NotSupported);

        #[cfg(target_os = "macos")]
        {
            let escaped_script = script.replace("'", "'\"'\"'");
            let output = Command::new("osascript")
                .arg("-e")
                .arg(&escaped_script)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .await?;

            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(IMessageError::applescript(stderr.to_string()))
            }
        }
    }

    fn parse_messages_result(&self, result: &str) -> Vec<IMessageMessage> {
        parse_messages_from_applescript(result)
    }

    fn parse_chats_result(&self, result: &str) -> Vec<IMessageChat> {
        parse_chats_from_applescript(result)
    }
}

/// Parse tab-delimited AppleScript messages output.
///
/// Expected format per line: `"id\ttext\tdate_sent\tis_from_me\tchat_identifier\tsender"`
pub fn parse_messages_from_applescript(result: &str) -> Vec<IMessageMessage> {
    let mut messages = Vec::new();
    let trimmed = result.trim();
    if trimmed.is_empty() {
        return messages;
    }

    for line in trimmed.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 6 {
            continue;
        }

        let id = fields[0].to_string();
        let text = fields[1].to_string();
        let date_sent = fields[2];
        let is_from_me_str = fields[3];
        let chat_identifier = fields[4].to_string();
        let sender = fields[5].to_string();

        let is_from_me =
            is_from_me_str == "1" || is_from_me_str.eq_ignore_ascii_case("true");

        let timestamp = date_sent.parse::<i64>().unwrap_or(0);

        messages.push(IMessageMessage {
            id,
            text,
            handle: sender,
            chat_id: chat_identifier,
            timestamp,
            is_from_me,
            has_attachments: false,
            attachment_paths: Vec::new(),
        });
    }

    messages
}

/// Parse tab-delimited AppleScript chats output.
///
/// Expected format per line: `"chat_identifier\tdisplay_name\tparticipant_count\tlast_message_date"`
pub fn parse_chats_from_applescript(result: &str) -> Vec<IMessageChat> {
    let mut chats = Vec::new();
    let trimmed = result.trim();
    if trimmed.is_empty() {
        return chats;
    }

    for line in trimmed.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 4 {
            continue;
        }

        let chat_identifier = fields[0].to_string();
        let display_name_raw = fields[1];
        let participant_count_str = fields[2];

        let participant_count: usize = participant_count_str.parse().unwrap_or(0);
        let chat_type = if participant_count > 1 {
            IMessageChatType::Group
        } else {
            IMessageChatType::Direct
        };

        let display_name = if display_name_raw.is_empty() {
            None
        } else {
            Some(display_name_raw.to_string())
        };

        chats.push(IMessageChat {
            chat_id: chat_identifier,
            chat_type,
            display_name,
            participants: Vec::new(),
        });
    }

    chats
}

impl Default for IMessageService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Service for IMessageService {
    fn name(&self) -> &str {
        IMESSAGE_SERVICE_NAME
    }

    fn description(&self) -> &str {
        "iMessage service for macOS"
    }

    async fn start(&mut self, _runtime: &dyn IAgentRuntime) -> elizaos::Result<()> {
        self.initialize()
            .await
            .map_err(|e| elizaos::Error::ServiceError(e.to_string()))
    }

    async fn stop(&mut self, _runtime: &dyn IAgentRuntime) -> elizaos::Result<()> {
        self.stop().await;
        Ok(())
    }
}
