//! Type definitions for the iMessage plugin

use serde::{Deserialize, Serialize};

/// Maximum message length for iMessage
pub const MAX_IMESSAGE_MESSAGE_LENGTH: usize = 4000;

/// Default poll interval in milliseconds
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 5000;

/// DM policy options
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DmPolicy {
    /// Allow all DMs
    Open,
    /// Require pairing approval
    #[default]
    Pairing,
    /// Only allow from allowlist
    Allowlist,
    /// Disable all DMs
    Disabled,
}

/// Group policy options
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum GroupPolicy {
    /// Allow all groups
    Open,
    /// Only allow from allowlist
    #[default]
    Allowlist,
    /// Disable all groups
    Disabled,
}

/// iMessage chat type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IMessageChatType {
    Direct,
    Group,
}

/// iMessage contact
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IMessageContact {
    /// Handle (phone number or email)
    pub handle: String,
    /// Display name
    pub display_name: Option<String>,
    /// Is this a phone number?
    pub is_phone_number: bool,
}

/// iMessage chat
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IMessageChat {
    /// Chat ID
    pub chat_id: String,
    /// Chat type
    pub chat_type: IMessageChatType,
    /// Display name
    pub display_name: Option<String>,
    /// Participants
    pub participants: Vec<IMessageContact>,
}

/// iMessage message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IMessageMessage {
    /// Message ID (ROWID)
    pub id: String,
    /// Message text
    pub text: String,
    /// Sender handle
    pub handle: String,
    /// Chat ID
    pub chat_id: String,
    /// Timestamp
    pub timestamp: i64,
    /// Is from me
    pub is_from_me: bool,
    /// Has attachments
    pub has_attachments: bool,
    /// Attachment paths
    pub attachment_paths: Vec<String>,
}

/// Options for sending a message
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IMessageSendOptions {
    /// Media URL or path to attach
    pub media_url: Option<String>,
    /// Max bytes for media
    pub max_bytes: Option<usize>,
}

/// Result from sending a message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IMessageSendResult {
    pub success: bool,
    pub message_id: Option<String>,
    pub chat_id: Option<String>,
    pub error: Option<String>,
}

impl IMessageSendResult {
    /// Creates a successful result
    pub fn success(message_id: String, chat_id: String) -> Self {
        Self {
            success: true,
            message_id: Some(message_id),
            chat_id: Some(chat_id),
            error: None,
        }
    }

    /// Creates a failed result
    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            success: false,
            message_id: None,
            chat_id: None,
            error: Some(error.into()),
        }
    }
}

/// Check if a string looks like a phone number
pub fn is_phone_number(input: &str) -> bool {
    let cleaned: String = input
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .collect();
    let pattern = regex::Regex::new(r"^\+?\d{10,15}$").unwrap();
    pattern.is_match(&cleaned)
}

/// Check if a string looks like an email
pub fn is_email(input: &str) -> bool {
    let pattern = regex::Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").unwrap();
    pattern.is_match(input)
}

/// Check if a string is a valid iMessage target (phone or email)
pub fn is_valid_imessage_target(target: &str) -> bool {
    let trimmed = target.trim();
    is_phone_number(trimmed) || is_email(trimmed) || trimmed.starts_with("chat_id:")
}

/// Normalize an iMessage target
pub fn normalize_imessage_target(target: &str) -> Option<String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Handle chat_id: prefix
    if trimmed.starts_with("chat_id:") {
        return Some(trimmed.to_string());
    }

    // Handle imessage: prefix
    if let Some(stripped) = trimmed.to_lowercase().strip_prefix("imessage:") {
        return Some(stripped.trim().to_string());
    }

    Some(trimmed.to_string())
}

/// Format a phone number for iMessage
pub fn format_phone_number(phone: &str) -> String {
    // Remove formatting
    let cleaned: String = phone
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .collect();

    // Add + prefix if missing for international
    if cleaned.len() > 10 && !cleaned.starts_with('+') {
        format!("+{}", cleaned)
    } else {
        cleaned
    }
}

/// Split text for iMessage
pub fn split_message_for_imessage(text: &str, max_length: usize) -> Vec<String> {
    if text.len() <= max_length {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= max_length {
            chunks.push(remaining.to_string());
            break;
        }

        let mut break_point = max_length;

        // Try newline first
        if let Some(idx) = remaining[..max_length].rfind('\n') {
            if idx > max_length / 2 {
                break_point = idx + 1;
            }
        } else if let Some(idx) = remaining[..max_length].rfind(' ') {
            // Try space
            if idx > max_length / 2 {
                break_point = idx + 1;
            }
        }

        chunks.push(remaining[..break_point].trim_end().to_string());
        remaining = remaining[break_point..].trim_start();
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_phone_number() {
        assert!(is_phone_number("+15551234567"));
        assert!(is_phone_number("1-555-123-4567"));
        assert!(is_phone_number("+44 7700 900000"));
        assert!(!is_phone_number("test@email.com"));
        assert!(!is_phone_number("12345")); // Too short
    }

    #[test]
    fn test_is_email() {
        assert!(is_email("test@example.com"));
        assert!(is_email("user.name@domain.co.uk"));
        assert!(!is_email("+15551234567"));
        assert!(!is_email("not an email"));
    }

    #[test]
    fn test_format_phone_number() {
        assert_eq!(format_phone_number("+1 (555) 123-4567"), "+15551234567");
        assert_eq!(format_phone_number("15551234567"), "+15551234567");
    }

    #[test]
    fn test_split_message() {
        let short = "Hello world";
        assert_eq!(split_message_for_imessage(short, 100), vec!["Hello world"]);

        let long = "Hello world. This is a test message.";
        let chunks = split_message_for_imessage(long, 20);
        assert!(chunks.len() > 1);
    }
}
