#![allow(missing_docs)]

use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{interval, Duration};
use tracing::{debug, info, warn};

use crate::client::FarcasterClient;
use crate::config::FarcasterConfig;
use crate::error::{FarcasterError, Result};
use crate::types::{Cast, CastId, FidRequest, Profile};

pub type MentionCallback = Arc<dyn Fn(Cast) + Send + Sync>;

pub struct FarcasterService {
    config: FarcasterConfig,
    client: Arc<RwLock<Option<FarcasterClient>>>,
    running: Arc<RwLock<bool>>,
    mention_callback: Arc<RwLock<Option<MentionCallback>>>,
}

impl FarcasterService {
    pub fn new(config: FarcasterConfig) -> Self {
        Self {
            config,
            client: Arc::new(RwLock::new(None)),
            running: Arc::new(RwLock::new(false)),
            mention_callback: Arc::new(RwLock::new(None)),
        }
    }

    pub fn from_env() -> Result<Self> {
        let config = FarcasterConfig::from_env()?;
        Ok(Self::new(config))
    }

    pub async fn start(&self) -> Result<()> {
        {
            let running = self.running.read().await;
            if *running {
                return Ok(());
            }
        }

        self.config.validate()?;

        let client = FarcasterClient::new(self.config.clone())?;
        {
            let mut client_guard = self.client.write().await;
            *client_guard = Some(client);
        }

        {
            let mut running = self.running.write().await;
            *running = true;
        }

        info!("Farcaster service started for FID {}", self.config.fid);

        if matches!(self.config.mode, crate::config::FarcasterMode::Polling) {
            self.start_poll_loop();
        }

        Ok(())
    }

    pub async fn stop(&self) {
        {
            let mut running = self.running.write().await;
            *running = false;
        }

        {
            let mut client = self.client.write().await;
            *client = None;
        }

        info!("Farcaster service stopped");
    }

    fn start_poll_loop(&self) {
        let running = Arc::clone(&self.running);
        let client = Arc::clone(&self.client);
        let callback: Arc<RwLock<Option<MentionCallback>>> = Arc::clone(&self.mention_callback);
        let poll_interval = self.config.poll_interval;
        let fid = self.config.fid;

        tokio::spawn(async move {
            let mut interval = interval(Duration::from_secs(poll_interval));

            loop {
                interval.tick().await;

                let is_running = *running.read().await;
                if !is_running {
                    break;
                }

                let client_guard = client.read().await;
                if let Some(ref client) = *client_guard {
                    let request = FidRequest::new(fid, 50);
                    match client.get_mentions(&request).await {
                        Ok(mentions) => {
                            let cb = callback.read().await;
                            if let Some(ref callback_fn) = *cb {
                                for cast in mentions {
                                    callback_fn(cast);
                                }
                            }
                        }
                        Err(e) => {
                            warn!("Error fetching mentions: {}", e);
                        }
                    }
                }
            }

            debug!("Poll loop exited");
        });
    }

    pub async fn on_mention(&self, callback: MentionCallback) {
        let mut cb = self.mention_callback.write().await;
        *cb = Some(callback);
    }

    pub async fn send_cast(&self, text: &str, reply_to: Option<&str>) -> Result<Vec<Cast>> {
        let client_guard = self.client.read().await;
        let client = client_guard
            .as_ref()
            .ok_or_else(|| FarcasterError::config("Service not started"))?;

        let in_reply_to = reply_to.map(|hash| CastId::new(hash, self.config.fid));
        client.send_cast(text, in_reply_to).await
    }

    pub async fn get_cast(&self, cast_hash: &str) -> Result<Cast> {
        let client_guard = self.client.read().await;
        let client = client_guard
            .as_ref()
            .ok_or_else(|| FarcasterError::config("Service not started"))?;

        client.get_cast(cast_hash).await
    }

    pub async fn get_profile(&self, fid: u64) -> Result<Profile> {
        let client_guard = self.client.read().await;
        let client = client_guard
            .as_ref()
            .ok_or_else(|| FarcasterError::config("Service not started"))?;

        client.get_profile(fid).await
    }

    pub async fn get_timeline(&self, limit: u32) -> Result<(Vec<Cast>, Option<String>)> {
        let client_guard = self.client.read().await;
        let client = client_guard
            .as_ref()
            .ok_or_else(|| FarcasterError::config("Service not started"))?;

        let request = FidRequest::new(self.config.fid, limit);
        client.get_timeline(&request).await
    }

    pub async fn is_running(&self) -> bool {
        *self.running.read().await
    }

    pub fn fid(&self) -> u64 {
        self.config.fid
    }

    pub fn config(&self) -> &FarcasterConfig {
        &self.config
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> FarcasterConfig {
        FarcasterConfig::new(12345, "test-signer", "test-api-key").with_dry_run(true)
    }

    #[tokio::test]
    async fn test_service_creation() {
        let service = FarcasterService::new(test_config());
        assert_eq!(service.fid(), 12345);
        assert!(!service.is_running().await);
    }

    #[tokio::test]
    async fn test_service_start_stop() {
        let service = FarcasterService::new(test_config());

        service.start().await.unwrap();
        assert!(service.is_running().await);

        service.stop().await;
        assert!(!service.is_running().await);
    }
}
