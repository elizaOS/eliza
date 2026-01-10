//! Farcaster actions for elizaOS agents.

use crate::error::Result;
use crate::service::FarcasterService;
use crate::types::Cast;

/// Action for sending a cast.
#[derive(Debug, Clone)]
pub struct SendCastAction {
    /// Action name
    pub name: &'static str,
    /// Action description
    pub description: &'static str,
}

impl Default for SendCastAction {
    fn default() -> Self {
        Self::new()
    }
}

impl SendCastAction {
    /// Create a new send cast action.
    pub fn new() -> Self {
        Self {
            name: "SEND_CAST",
            description: "Posts a cast (message) on Farcaster",
        }
    }

    /// Validate if this action should be executed.
    pub fn validate(&self, text: &str, service: Option<&FarcasterService>) -> bool {
        let keywords = ["post", "cast", "share", "announce", "farcaster", "tweet"];
        let text_lower = text.to_lowercase();
        let has_keyword = keywords.iter().any(|k| text_lower.contains(k));
        has_keyword && service.is_some()
    }

    /// Execute the action.
    pub async fn execute(&self, text: &str, service: &FarcasterService) -> Result<Vec<Cast>> {
        // Truncate if needed
        let text = if text.len() > 320 {
            format!("{}...", &text[..317])
        } else {
            text.to_string()
        };
        service.send_cast(&text, None).await
    }
}

/// Action for replying to a cast.
#[derive(Debug, Clone)]
pub struct ReplyCastAction {
    /// Action name
    pub name: &'static str,
    /// Action description
    pub description: &'static str,
}

impl Default for ReplyCastAction {
    fn default() -> Self {
        Self::new()
    }
}

impl ReplyCastAction {
    /// Create a new reply cast action.
    pub fn new() -> Self {
        Self {
            name: "REPLY_TO_CAST",
            description: "Replies to a cast on Farcaster",
        }
    }

    /// Validate if this action should be executed.
    pub fn validate(
        &self,
        text: &str,
        parent_hash: Option<&str>,
        service: Option<&FarcasterService>,
    ) -> bool {
        let keywords = ["reply", "respond", "answer", "comment"];
        let text_lower = text.to_lowercase();
        let has_keyword = keywords.iter().any(|k| text_lower.contains(k));
        has_keyword && parent_hash.is_some() && service.is_some()
    }

    /// Execute the action.
    pub async fn execute(
        &self,
        text: &str,
        parent_hash: &str,
        _parent_fid: u64,
        service: &FarcasterService,
    ) -> Result<Vec<Cast>> {
        // Truncate if needed
        let text = if text.len() > 320 {
            format!("{}...", &text[..317])
        } else {
            text.to_string()
        };
        service.send_cast(&text, Some(parent_hash)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_send_cast_action_validate() {
        let action = SendCastAction::new();
        
        // Without service
        assert!(!action.validate("post this on farcaster", None));
        
        // With matching keyword but no service
        assert!(!action.validate("please share this", None));
    }

    #[test]
    fn test_reply_cast_action_validate() {
        let action = ReplyCastAction::new();
        
        // Without parent or service
        assert!(!action.validate("reply to this", None, None));
        
        // With parent but no service
        assert!(!action.validate("reply to this", Some("0xabc"), None));
    }
}

