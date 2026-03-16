#![allow(missing_docs)]

use crate::client::RssClient;
use crate::error::Result;
use crate::types::RssFeed;

/// Minimal service wrapper for RSS/Atom feeds (TS parity: `RssService`).
pub struct RssService {
    client: RssClient,
}

impl RssService {
    pub const SERVICE_TYPE: &'static str = "RSS";
    pub const CAPABILITY_DESCRIPTION: &'static str =
        "The agent is able to deal with RSS/atom feeds";

    pub fn try_new() -> Result<Self> {
        Ok(Self {
            client: RssClient::default_client()?,
        })
    }

    pub fn new() -> Self {
        Self::try_new().expect("Failed to create default RSS client")
    }

    pub fn client(&self) -> &RssClient {
        &self.client
    }

    pub async fn fetch_url(&self, url: &str) -> Result<RssFeed> {
        self.client.fetch_feed(url).await
    }
}

impl Default for RssService {
    fn default() -> Self {
        Self::new()
    }
}
