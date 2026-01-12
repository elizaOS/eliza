//! X (Twitter) main service orchestration.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tracing::info;

/// X Client Instance - orchestrates all X (formerly Twitter) functionality.
///
/// Components:
/// - client: base operations (auth, timeline caching)
/// - post: autonomous posting
/// - interaction: mentions and replies
/// - timeline: actions (likes, reposts, replies)
/// - discovery: content discovery and engagement
pub struct XService {
    is_running: Arc<AtomicBool>,
    post_enabled: bool,
    replies_enabled: bool,
    actions_enabled: bool,
    discovery_enabled: bool,
}

impl XService {
    /// Service type identifier.
    pub const SERVICE_TYPE: &'static str = "x";

    /// Service capability description.
    pub const CAPABILITY_DESCRIPTION: &'static str =
        "Send and receive posts on X (formerly Twitter)";

    /// Creates a new X service instance.
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
            post_enabled: false,
            replies_enabled: true,
            actions_enabled: false,
            discovery_enabled: false,
        }
    }

    /// Starts the X service with the given settings.
    pub async fn start(&mut self, settings: &XServiceSettings) -> crate::error::Result<()> {
        self.post_enabled = settings.post_enabled;
        self.replies_enabled = settings.replies_enabled;
        self.actions_enabled = settings.actions_enabled;
        self.discovery_enabled = settings.discovery_enabled
            || (settings.actions_enabled && !settings.discovery_explicitly_disabled);

        if self.post_enabled {
            info!("X posting ENABLED");
        }
        if self.replies_enabled {
            info!("X replies ENABLED");
        }
        if self.actions_enabled {
            info!("X timeline actions ENABLED");
        }
        if self.discovery_enabled {
            info!("X discovery ENABLED");
        }

        self.is_running.store(true, Ordering::SeqCst);
        info!("X configuration validated");
        Ok(())
    }

    /// Stops the X service.
    pub async fn stop(&self) -> crate::error::Result<()> {
        self.is_running.store(false, Ordering::SeqCst);
        info!("X service stopped");
        Ok(())
    }

    /// Checks if the service is running.
    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }

    /// Checks if posting is enabled.
    pub fn post_enabled(&self) -> bool {
        self.post_enabled
    }

    /// Checks if replies are enabled.
    pub fn replies_enabled(&self) -> bool {
        self.replies_enabled
    }

    /// Checks if timeline actions are enabled.
    pub fn actions_enabled(&self) -> bool {
        self.actions_enabled
    }

    /// Checks if discovery is enabled.
    pub fn discovery_enabled(&self) -> bool {
        self.discovery_enabled
    }
}

impl Default for XService {
    fn default() -> Self {
        Self::new()
    }
}

/// Settings for the X service.
#[derive(Debug, Clone, Default)]
pub struct XServiceSettings {
    /// Whether posting is enabled.
    pub post_enabled: bool,
    /// Whether replies are enabled.
    pub replies_enabled: bool,
    /// Whether timeline actions are enabled.
    pub actions_enabled: bool,
    /// Whether discovery is enabled.
    pub discovery_enabled: bool,
    /// Whether discovery was explicitly disabled.
    pub discovery_explicitly_disabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_x_service_lifecycle() {
        let mut service = XService::new();
        assert!(!service.is_running());

        let settings = XServiceSettings {
            post_enabled: true,
            replies_enabled: true,
            ..Default::default()
        };
        service.start(&settings).await.unwrap();

        assert!(service.is_running());
        assert!(service.post_enabled());
        assert!(service.replies_enabled());

        service.stop().await.unwrap();
        assert!(!service.is_running());
    }
}
