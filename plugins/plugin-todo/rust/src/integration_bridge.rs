//! Integration bridge service for connecting with other plugins.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tracing::info;

/// Integration bridge service for connecting todo plugin with other plugins.
///
/// This service enables enhanced functionality by bridging the todo plugin
/// with other plugins in the system.
pub struct TodoIntegrationBridge {
    is_running: Arc<AtomicBool>,
}

impl TodoIntegrationBridge {
    /// Service type identifier.
    pub const SERVICE_TYPE: &'static str = "TODO_INTEGRATION_BRIDGE";

    /// Service capability description.
    pub const CAPABILITY_DESCRIPTION: &'static str =
        "Bridges todo plugin with other plugins for enhanced functionality";

    /// Creates a new integration bridge instance.
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Starts the integration bridge service.
    pub async fn start(&self) -> crate::error::Result<()> {
        info!("Starting TodoIntegrationBridge...");
        self.initialize().await?;
        self.is_running.store(true, Ordering::SeqCst);
        info!("TodoIntegrationBridge started successfully");
        Ok(())
    }

    /// Initializes the service.
    async fn initialize(&self) -> crate::error::Result<()> {
        // Initialization complete
        Ok(())
    }

    /// Stops the integration bridge service.
    pub async fn stop(&self) -> crate::error::Result<()> {
        self.is_running.store(false, Ordering::SeqCst);
        info!("TodoIntegrationBridge stopped");
        Ok(())
    }

    /// Checks if the service is running.
    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }
}

impl Default for TodoIntegrationBridge {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_integration_bridge_lifecycle() {
        let bridge = TodoIntegrationBridge::new();
        assert!(!bridge.is_running());

        bridge.start().await.unwrap();
        assert!(bridge.is_running());

        bridge.stop().await.unwrap();
        assert!(!bridge.is_running());
    }
}
