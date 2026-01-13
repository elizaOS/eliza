#![allow(missing_docs)]

use crate::config::FarcasterConfig;
use crate::service::FarcasterService;

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

    pub async fn get(&self) -> String {
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

    pub async fn get(&self, limit: u32) -> String {
        match self.service.get_timeline(limit).await {
            Ok((casts, _)) => {
                use crate::types::Cast;
                let casts: Vec<Cast> = casts;
                if casts.is_empty() {
                    return "No recent casts in timeline.".to_string();
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
                lines.join("\n")
            }
            Err(e) => format!("Error fetching Farcaster timeline: {}", e),
        }
    }
}

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

    pub async fn get(&self, cast_hash: &str, max_depth: usize) -> String {
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
            return "No thread context available.".to_string();
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
        lines.join("\n")
    }
}
