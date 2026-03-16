#![allow(missing_docs)]

use crate::error::Result;
use crate::service::FarcasterService;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Result returned by action handlers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub data: HashMap<String, String>,
}

impl ActionResult {
    pub fn ok(text: impl Into<String>, data: HashMap<String, String>) -> Self {
        Self {
            success: true,
            text: Some(text.into()),
            error: None,
            data,
        }
    }

    pub fn err(error: impl Into<String>) -> Self {
        Self {
            success: false,
            text: None,
            error: Some(error.into()),
            data: HashMap::new(),
        }
    }
}

/// Example pair for an action (user prompt + assistant response).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionExample {
    pub name: String,
    pub content: HashMap<String, serde_json::Value>,
}

// ---------------------------------------------------------------------------
// SendCastAction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SendCastAction {
    pub name: &'static str,
    pub description: &'static str,
    pub similes: &'static [&'static str],
    pub examples: Vec<Vec<ActionExample>>,
}

impl Default for SendCastAction {
    fn default() -> Self {
        Self::new()
    }
}

impl SendCastAction {
    pub const KEYWORDS: &'static [&'static str] =
        &["post", "cast", "share", "announce", "farcaster"];

    pub fn new() -> Self {
        Self {
            name: "SEND_CAST",
            description: "Posts a cast (message) on Farcaster",
            similes: &[
                "POST_CAST",
                "FARCASTER_POST",
                "CAST",
                "SHARE_ON_FARCASTER",
                "ANNOUNCE",
            ],
            examples: vec![
                vec![
                    ActionExample {
                        name: "User".to_string(),
                        content: HashMap::from([
                            ("text".to_string(), serde_json::json!("Post 'Hello Farcaster!' to my timeline")),
                            ("source".to_string(), serde_json::json!("user")),
                        ]),
                    },
                    ActionExample {
                        name: "Agent".to_string(),
                        content: HashMap::from([
                            ("text".to_string(), serde_json::json!("I've posted your message to Farcaster!")),
                            ("actions".to_string(), serde_json::json!(["SEND_CAST"])),
                        ]),
                    },
                ],
                vec![
                    ActionExample {
                        name: "User".to_string(),
                        content: HashMap::from([
                            ("text".to_string(), serde_json::json!("Share this announcement on Farcaster")),
                            ("source".to_string(), serde_json::json!("user")),
                        ]),
                    },
                    ActionExample {
                        name: "Agent".to_string(),
                        content: HashMap::from([
                            ("text".to_string(), serde_json::json!("Your announcement has been posted to Farcaster.")),
                            ("actions".to_string(), serde_json::json!(["SEND_CAST"])),
                        ]),
                    },
                ],
            ],
        }
    }

    /// Check whether the user message text signals intent to send a cast
    /// and whether the service is available.
    pub fn validate(&self, text: &str, service_running: bool) -> bool {
        if !service_running {
            return false;
        }
        let text_lower = text.to_lowercase();
        Self::KEYWORDS.iter().any(|k| text_lower.contains(k))
    }

    /// Execute the action: truncate text if necessary and send via the service.
    pub async fn execute(
        &self,
        text: &str,
        service: &FarcasterService,
    ) -> Result<ActionResult> {
        if !service.is_running().await {
            return Ok(ActionResult::err("Farcaster service is not running"));
        }

        let text = if text.len() > 320 {
            format!("{}...", &text[..317])
        } else {
            text.to_string()
        };

        let casts = service.send_cast(&text, None).await?;
        if casts.is_empty() {
            return Ok(ActionResult::err("No cast returned"));
        }

        let cast = &casts[0];
        let mut data = HashMap::new();
        data.insert("cast_hash".to_string(), cast.hash.clone());
        data.insert("text".to_string(), cast.text.clone());
        data.insert("author_fid".to_string(), cast.author_fid.to_string());

        Ok(ActionResult::ok("Cast posted successfully!", data))
    }
}

// ---------------------------------------------------------------------------
// ReplyCastAction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ReplyCastAction {
    pub name: &'static str,
    pub description: &'static str,
    pub similes: &'static [&'static str],
    pub examples: Vec<Vec<ActionExample>>,
}

impl Default for ReplyCastAction {
    fn default() -> Self {
        Self::new()
    }
}

impl ReplyCastAction {
    pub const KEYWORDS: &'static [&'static str] = &["reply", "respond", "answer", "comment"];

    pub fn new() -> Self {
        Self {
            name: "REPLY_TO_CAST",
            description: "Replies to a cast on Farcaster",
            similes: &["REPLY_CAST", "RESPOND_CAST", "ANSWER_CAST", "COMMENT_CAST"],
            examples: vec![
                vec![
                    ActionExample {
                        name: "User".to_string(),
                        content: HashMap::from([
                            ("text".to_string(), serde_json::json!("Reply 'Great point!' to that cast")),
                            ("source".to_string(), serde_json::json!("user")),
                        ]),
                    },
                    ActionExample {
                        name: "Agent".to_string(),
                        content: HashMap::from([
                            ("text".to_string(), serde_json::json!("I've replied to the cast!")),
                            ("actions".to_string(), serde_json::json!(["REPLY_TO_CAST"])),
                        ]),
                    },
                ],
                vec![
                    ActionExample {
                        name: "User".to_string(),
                        content: HashMap::from([
                            ("text".to_string(), serde_json::json!("Respond to the thread with my thoughts")),
                            ("source".to_string(), serde_json::json!("user")),
                        ]),
                    },
                    ActionExample {
                        name: "Agent".to_string(),
                        content: HashMap::from([
                            ("text".to_string(), serde_json::json!("Your reply has been posted.")),
                            ("actions".to_string(), serde_json::json!(["REPLY_TO_CAST"])),
                        ]),
                    },
                ],
            ],
        }
    }

    /// Validate that the text has reply intent, a parent hash exists, and the
    /// service is running.
    pub fn validate(
        &self,
        text: &str,
        parent_hash: Option<&str>,
        service_running: bool,
    ) -> bool {
        if !service_running || parent_hash.is_none() {
            return false;
        }
        let text_lower = text.to_lowercase();
        Self::KEYWORDS.iter().any(|k| text_lower.contains(k))
    }

    /// Execute the reply action.
    pub async fn execute(
        &self,
        text: &str,
        parent_hash: &str,
        service: &FarcasterService,
    ) -> Result<ActionResult> {
        if !service.is_running().await {
            return Ok(ActionResult::err("Farcaster service is not running"));
        }

        let text = if text.len() > 320 {
            format!("{}...", &text[..317])
        } else {
            text.to_string()
        };

        let casts = service.send_cast(&text, Some(parent_hash)).await?;
        if casts.is_empty() {
            return Ok(ActionResult::err("No cast returned"));
        }

        let cast = &casts[0];
        let mut data = HashMap::new();
        data.insert("cast_hash".to_string(), cast.hash.clone());
        data.insert("text".to_string(), cast.text.clone());
        data.insert("parent_hash".to_string(), parent_hash.to_string());
        data.insert("author_fid".to_string(), cast.author_fid.to_string());

        Ok(ActionResult::ok("Reply posted successfully!", data))
    }
}

/// Convenience: return all built-in actions as a vector of trait-object-like
/// tuples `(name, description)`.  The caller is responsible for dispatching.
pub fn all_action_names() -> Vec<(&'static str, &'static str)> {
    vec![
        (SendCastAction::new().name, SendCastAction::new().description),
        (ReplyCastAction::new().name, ReplyCastAction::new().description),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── SendCastAction ──────────────────────────────────────────────────

    #[test]
    fn test_send_cast_action_metadata() {
        let action = SendCastAction::new();
        assert_eq!(action.name, "SEND_CAST");
        assert!(!action.description.is_empty());
        assert!(action.similes.contains(&"POST_CAST"));
        assert!(action.similes.contains(&"FARCASTER_POST"));
        assert!(!action.examples.is_empty());
    }

    #[test]
    fn test_send_cast_validate_with_service() {
        let action = SendCastAction::new();
        assert!(action.validate("post this on farcaster", true));
        assert!(action.validate("Please cast my message", true));
        assert!(action.validate("share this announcement", true));
        assert!(action.validate("I want to announce something", true));
    }

    #[test]
    fn test_send_cast_validate_no_keyword() {
        let action = SendCastAction::new();
        assert!(!action.validate("hello world", true));
        assert!(!action.validate("do something", true));
    }

    #[test]
    fn test_send_cast_validate_service_not_running() {
        let action = SendCastAction::new();
        assert!(!action.validate("post this on farcaster", false));
    }

    #[test]
    fn test_send_cast_validate_case_insensitive() {
        let action = SendCastAction::new();
        assert!(action.validate("POST THIS ON FARCASTER", true));
        assert!(action.validate("Share This", true));
    }

    // ── ReplyCastAction ─────────────────────────────────────────────────

    #[test]
    fn test_reply_cast_action_metadata() {
        let action = ReplyCastAction::new();
        assert_eq!(action.name, "REPLY_TO_CAST");
        assert!(!action.description.is_empty());
        assert!(action.similes.contains(&"REPLY_CAST"));
        assert!(action.similes.contains(&"RESPOND_CAST"));
        assert!(!action.examples.is_empty());
    }

    #[test]
    fn test_reply_cast_validate_all_conditions() {
        let action = ReplyCastAction::new();
        assert!(action.validate("reply to this", Some("0xabc"), true));
        assert!(action.validate("respond to the thread", Some("0xdef"), true));
        assert!(action.validate("answer their question", Some("0x123"), true));
        assert!(action.validate("comment on this cast", Some("0x456"), true));
    }

    #[test]
    fn test_reply_cast_validate_missing_parent() {
        let action = ReplyCastAction::new();
        assert!(!action.validate("reply to this", None, true));
    }

    #[test]
    fn test_reply_cast_validate_service_not_running() {
        let action = ReplyCastAction::new();
        assert!(!action.validate("reply to this", Some("0xabc"), false));
    }

    #[test]
    fn test_reply_cast_validate_no_keyword() {
        let action = ReplyCastAction::new();
        assert!(!action.validate("hello world", Some("0xabc"), true));
    }

    // ── ActionResult ────────────────────────────────────────────────────

    #[test]
    fn test_action_result_ok() {
        let mut data = HashMap::new();
        data.insert("cast_hash".to_string(), "0xabc".to_string());
        let result = ActionResult::ok("Cast posted!", data.clone());
        assert!(result.success);
        assert_eq!(result.text.as_deref(), Some("Cast posted!"));
        assert!(result.error.is_none());
        assert_eq!(result.data.get("cast_hash").map(String::as_str), Some("0xabc"));
    }

    #[test]
    fn test_action_result_err() {
        let result = ActionResult::err("something went wrong");
        assert!(!result.success);
        assert!(result.text.is_none());
        assert_eq!(result.error.as_deref(), Some("something went wrong"));
        assert!(result.data.is_empty());
    }

    #[test]
    fn test_action_result_serialization() {
        let result = ActionResult::ok("done", HashMap::new());
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"success\":true"));
        assert!(json.contains("\"text\":\"done\""));

        let deserialized: ActionResult = serde_json::from_str(&json).unwrap();
        assert!(deserialized.success);
    }

    // ── all_action_names ────────────────────────────────────────────────

    #[test]
    fn test_all_action_names() {
        let names = all_action_names();
        assert_eq!(names.len(), 2);
        assert_eq!(names[0].0, "SEND_CAST");
        assert_eq!(names[1].0, "REPLY_TO_CAST");
    }

    // ── Example structure ───────────────────────────────────────────────

    #[test]
    fn test_send_cast_examples_structure() {
        let action = SendCastAction::new();
        for example_set in &action.examples {
            assert_eq!(example_set.len(), 2); // user + agent
            assert_eq!(example_set[0].name, "User");
            assert_eq!(example_set[1].name, "Agent");
            assert!(example_set[0].content.contains_key("text"));
            assert!(example_set[1].content.contains_key("text"));
            assert!(example_set[1].content.contains_key("actions"));
        }
    }

    #[test]
    fn test_reply_cast_examples_structure() {
        let action = ReplyCastAction::new();
        for example_set in &action.examples {
            assert_eq!(example_set.len(), 2);
            assert_eq!(example_set[0].name, "User");
            assert_eq!(example_set[1].name, "Agent");
        }
    }
}
