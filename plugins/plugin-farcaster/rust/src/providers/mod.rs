#![allow(missing_docs)]

use crate::config::FarcasterConfig;
use crate::service::FarcasterService;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Structured result from a provider, mirroring the TS/Python `ProviderResult`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderResult {
    /// Human-readable text summary.
    pub text: String,
    /// Structured data payload.
    #[serde(default)]
    pub data: HashMap<String, serde_json::Value>,
    /// Key-value pairs that can be injected into prompt templates.
    #[serde(default)]
    pub values: HashMap<String, String>,
}

impl ProviderResult {
    pub fn unavailable(text: impl Into<String>) -> Self {
        let mut data = HashMap::new();
        data.insert("available".to_string(), serde_json::json!(false));
        Self {
            text: text.into(),
            data,
            values: HashMap::new(),
        }
    }

    pub fn error(text: impl Into<String>, err_msg: impl Into<String>) -> Self {
        let mut data = HashMap::new();
        data.insert("available".to_string(), serde_json::json!(false));
        data.insert("error".to_string(), serde_json::json!(err_msg.into()));
        Self {
            text: text.into(),
            data,
            values: HashMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// TimelineProvider
// ---------------------------------------------------------------------------

pub struct TimelineProvider<'a> {
    service: &'a FarcasterService,
}

impl<'a> TimelineProvider<'a> {
    pub const NAME: &'static str = "farcaster_timeline";
    pub const TS_NAME: &'static str = "farcasterTimeline";
    pub const DESCRIPTION: &'static str = "Provides the agent's recent Farcaster timeline";

    pub fn new(service: &'a FarcasterService, _config: &'a FarcasterConfig) -> Self {
        Self { service }
    }

    /// Fetch the timeline and return a structured `ProviderResult`.
    pub async fn get(&self, limit: u32) -> ProviderResult {
        match self.service.get_timeline(limit).await {
            Ok((casts, _cursor)) => {
                if casts.is_empty() {
                    let mut data = HashMap::new();
                    data.insert("available".to_string(), serde_json::json!(true));
                    data.insert("casts".to_string(), serde_json::json!([]));
                    data.insert("count".to_string(), serde_json::json!(0));
                    return ProviderResult {
                        text: "No recent casts in timeline.".to_string(),
                        data,
                        values: HashMap::new(),
                    };
                }

                let mut lines = vec!["Recent Farcaster timeline:".to_string()];
                for cast in casts.iter().take(limit as usize) {
                    let timestamp = cast.timestamp.format("%Y-%m-%d %H:%M").to_string();
                    let text = if cast.text.len() > 100 {
                        format!("{}...", &cast.text[..100])
                    } else {
                        cast.text.clone()
                    };
                    lines.push(format!(
                        "- [{}] @{}: {}",
                        timestamp, cast.profile.username, text
                    ));
                }

                let mut data = HashMap::new();
                data.insert("available".to_string(), serde_json::json!(true));
                data.insert("castCount".to_string(), serde_json::json!(casts.len()));

                let mut values = HashMap::new();
                if let Some(first) = casts.first() {
                    values.insert("latestCastHash".to_string(), first.hash.clone());
                    values.insert("latestCastText".to_string(), first.text.clone());
                }

                ProviderResult {
                    text: lines.join("\n"),
                    data,
                    values,
                }
            }
            Err(e) => ProviderResult::error(
                "Error fetching Farcaster timeline.",
                e.to_string(),
            ),
        }
    }

    /// Get a plain text summary (convenience for simple use-cases).
    pub async fn get_text(&self, limit: u32) -> String {
        self.get(limit).await.text
    }
}

// ---------------------------------------------------------------------------
// ThreadProvider
// ---------------------------------------------------------------------------

/// Provider for Farcaster thread context.
pub struct ThreadProvider<'a> {
    service: &'a FarcasterService,
}

impl<'a> ThreadProvider<'a> {
    pub const NAME: &'static str = "farcaster_thread";
    pub const TS_NAME: &'static str = "farcasterThread";
    pub const DESCRIPTION: &'static str = "Provides thread context for a Farcaster conversation";

    pub fn new(service: &'a FarcasterService) -> Self {
        Self { service }
    }

    /// Walk the reply chain up to `max_depth` parents and return structured
    /// thread context.
    pub async fn get(&self, cast_hash: &str, max_depth: usize) -> ProviderResult {
        let mut thread = Vec::new();
        let mut visited = std::collections::HashSet::new();
        let mut current_hash = Some(cast_hash.to_string());

        while let Some(hash) = current_hash.take() {
            if thread.len() >= max_depth || visited.contains(&hash) {
                break;
            }
            visited.insert(hash.clone());

            match self.service.get_cast(&hash).await {
                Ok(cast) => {
                    current_hash = cast.in_reply_to.as_ref().map(|p| p.hash.clone());
                    thread.insert(0, cast);
                }
                Err(_) => break,
            }
        }

        if thread.is_empty() {
            return ProviderResult {
                text: "No thread context available.".to_string(),
                data: HashMap::from([
                    ("available".to_string(), serde_json::json!(false)),
                    ("castHash".to_string(), serde_json::json!(cast_hash)),
                    ("count".to_string(), serde_json::json!(0)),
                ]),
                values: HashMap::new(),
            };
        }

        let mut lines = vec!["Thread context:".to_string()];
        for (i, cast) in thread.iter().enumerate() {
            let prefix = if i == thread.len() - 1 {
                "└─"
            } else {
                "├─"
            };
            let text = if cast.text.len() > 80 {
                format!("{}...", &cast.text[..80])
            } else {
                cast.text.clone()
            };
            lines.push(format!("{} @{}: {}", prefix, cast.profile.username, text));
        }

        let formatted_thread = lines[1..].join("\n"); // without header
        let mut values = HashMap::new();
        values.insert("farcasterThread".to_string(), formatted_thread);
        values.insert("farcasterCastHash".to_string(), cast_hash.to_string());
        if let Some(last) = thread.last() {
            values.insert("farcasterCurrentCastText".to_string(), last.text.clone());
        }
        if thread.len() > 1 {
            if let Some(second_last) = thread.get(thread.len() - 2) {
                values.insert(
                    "farcasterParentCastText".to_string(),
                    second_last.text.clone(),
                );
            }
        }

        ProviderResult {
            text: lines.join("\n"),
            data: HashMap::from([
                ("available".to_string(), serde_json::json!(true)),
                ("castHash".to_string(), serde_json::json!(cast_hash)),
                ("count".to_string(), serde_json::json!(thread.len())),
            ]),
            values,
        }
    }

    /// Get a plain text summary.
    pub async fn get_text(&self, cast_hash: &str, max_depth: usize) -> String {
        self.get(cast_hash, max_depth).await.text
    }
}

// ---------------------------------------------------------------------------
// ProfileProvider
// ---------------------------------------------------------------------------

pub struct ProfileProvider<'a> {
    service: &'a FarcasterService,
    config: &'a FarcasterConfig,
}

impl<'a> ProfileProvider<'a> {
    pub const NAME: &'static str = "farcaster_profile";
    pub const TS_NAME: &'static str = "farcasterProfile";
    pub const DESCRIPTION: &'static str = "Provides the agent's Farcaster profile information";

    pub fn new(service: &'a FarcasterService, config: &'a FarcasterConfig) -> Self {
        Self { service, config }
    }

    /// Fetch the agent's profile and return structured data.
    pub async fn get(&self) -> ProviderResult {
        if self.config.fid == 0 {
            return ProviderResult::error(
                "Invalid Farcaster FID configured.",
                "Invalid FID",
            );
        }

        match self.service.get_profile(self.config.fid).await {
            Ok(profile) => {
                let display_name = if profile.name.is_empty() {
                    String::new()
                } else {
                    format!(" Display name: {}", profile.name)
                };

                let text = format!(
                    "Your Farcaster profile: @{} (FID: {}).{}",
                    profile.username, profile.fid, display_name,
                );

                let mut data = HashMap::new();
                data.insert("available".to_string(), serde_json::json!(true));
                data.insert("fid".to_string(), serde_json::json!(profile.fid));
                data.insert("username".to_string(), serde_json::json!(profile.username));
                data.insert("name".to_string(), serde_json::json!(profile.name));
                if let Some(ref pfp) = profile.pfp {
                    data.insert("pfp".to_string(), serde_json::json!(pfp));
                }

                let mut values = HashMap::new();
                values.insert("fid".to_string(), profile.fid.to_string());
                values.insert("username".to_string(), profile.username.clone());

                ProviderResult { text, data, values }
            }
            Err(e) => ProviderResult::error(
                "Unable to fetch Farcaster profile at this time.",
                e.to_string(),
            ),
        }
    }

    /// Get a multi-line text description (matches Python output format).
    pub async fn get_text(&self) -> String {
        match self.service.get_profile(self.config.fid).await {
            Ok(profile) => {
                format!(
                    "Farcaster Profile:\n\
                     - Username: @{}\n\
                     - Name: {}\n\
                     - FID: {}\n\
                     - Bio: {}",
                    profile.username,
                    profile.name,
                    profile.fid,
                    profile.bio.as_deref().unwrap_or("N/A")
                )
            }
            Err(e) => format!("Error fetching Farcaster profile: {}", e),
        }
    }
}

/// List all built-in provider names.
pub fn all_provider_names() -> Vec<(&'static str, &'static str)> {
    vec![
        (TimelineProvider::NAME, TimelineProvider::DESCRIPTION),
        (ThreadProvider::NAME, ThreadProvider::DESCRIPTION),
        (ProfileProvider::NAME, ProfileProvider::DESCRIPTION),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_names() {
        assert_eq!(TimelineProvider::NAME, "farcaster_timeline");
        assert_eq!(TimelineProvider::TS_NAME, "farcasterTimeline");
        assert_eq!(ThreadProvider::NAME, "farcaster_thread");
        assert_eq!(ThreadProvider::TS_NAME, "farcasterThread");
        assert_eq!(ProfileProvider::NAME, "farcaster_profile");
        assert_eq!(ProfileProvider::TS_NAME, "farcasterProfile");
    }

    #[test]
    fn test_provider_descriptions() {
        assert!(!TimelineProvider::DESCRIPTION.is_empty());
        assert!(!ThreadProvider::DESCRIPTION.is_empty());
        assert!(!ProfileProvider::DESCRIPTION.is_empty());
    }

    #[test]
    fn test_all_provider_names() {
        let names = all_provider_names();
        assert_eq!(names.len(), 3);
        assert_eq!(names[0].0, "farcaster_timeline");
        assert_eq!(names[1].0, "farcaster_thread");
        assert_eq!(names[2].0, "farcaster_profile");
    }

    #[test]
    fn test_provider_result_unavailable() {
        let result = ProviderResult::unavailable("not available");
        assert_eq!(result.text, "not available");
        assert_eq!(result.data.get("available"), Some(&serde_json::json!(false)));
        assert!(result.values.is_empty());
    }

    #[test]
    fn test_provider_result_error() {
        let result = ProviderResult::error("something failed", "details here");
        assert_eq!(result.text, "something failed");
        assert_eq!(result.data.get("available"), Some(&serde_json::json!(false)));
        assert_eq!(
            result.data.get("error"),
            Some(&serde_json::json!("details here"))
        );
    }

    #[test]
    fn test_provider_result_serialization() {
        let result = ProviderResult::unavailable("test");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"text\":\"test\""));
        let deserialized: ProviderResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.text, "test");
    }
}
