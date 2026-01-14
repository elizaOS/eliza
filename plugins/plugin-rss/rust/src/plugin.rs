#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::client::RssClient;
use crate::error::{Result, RssError};
use crate::types::{FeedFormat, FeedItemMetadata, FeedSubscriptionMetadata, RssConfig, RssFeed};

pub struct RssPlugin {
    config: RssConfig,
    client: Option<RssClient>,
    subscribed_feeds: Arc<RwLock<HashMap<String, FeedSubscriptionMetadata>>>,
    feed_items: Arc<RwLock<HashMap<String, FeedItemMetadata>>>,
}

impl RssPlugin {
    pub fn new(config: RssConfig) -> Self {
        Self {
            config,
            client: None,
            subscribed_feeds: Arc::new(RwLock::new(HashMap::new())),
            feed_items: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn default_plugin() -> Self {
        Self::new(RssConfig::default())
    }

    pub async fn start(&mut self) -> Result<()> {
        self.client = Some(RssClient::new(self.config.clone())?);
        let feeds: Vec<String> = self.config.feeds.clone();
        for url in feeds {
            let _ = self.subscribe_feed(&url, None).await;
        }

        Ok(())
    }

    pub async fn stop(&mut self) {
        self.client = None;
    }

    fn get_client(&mut self) -> Result<&RssClient> {
        if self.client.is_none() {
            self.client = Some(RssClient::new(self.config.clone())?);
        }
        Ok(self.client.as_ref().unwrap())
    }

    pub async fn fetch_feed(&mut self, url: &str) -> Result<RssFeed> {
        let client = self.get_client()?;
        client.fetch_feed(url).await
    }

    pub async fn subscribe_feed(&mut self, url: &str, title: Option<&str>) -> Result<()> {
        {
            let feeds: tokio::sync::RwLockReadGuard<'_, HashMap<String, FeedSubscriptionMetadata>> =
                self.subscribed_feeds.read().await;
            if feeds.contains_key(url) {
                return Err(RssError::AlreadySubscribed(url.to_string()));
            }
        }

        let _feed_title = if title.is_some() {
            title.map(|s: &str| s.to_string())
        } else {
            match self.fetch_feed(url).await {
                Ok(feed) => {
                    let title_str: &str = feed.title();
                    Some(title_str.to_string())
                }
                Err(_) => None,
            }
        };

        let metadata = FeedSubscriptionMetadata::new();

        let mut feeds: tokio::sync::RwLockWriteGuard<
            '_,
            HashMap<String, FeedSubscriptionMetadata>,
        > = self.subscribed_feeds.write().await;
        feeds.insert(url.to_string(), metadata);

        Ok(())
    }

    pub async fn unsubscribe_feed(&mut self, url: &str) -> Result<()> {
        let mut feeds: tokio::sync::RwLockWriteGuard<
            '_,
            HashMap<String, FeedSubscriptionMetadata>,
        > = self.subscribed_feeds.write().await;
        if feeds.remove(url).is_none() {
            return Err(RssError::NotSubscribed(url.to_string()));
        }
        Ok(())
    }

    pub async fn get_subscribed_feeds(&self) -> Vec<(String, FeedSubscriptionMetadata)> {
        let feeds: tokio::sync::RwLockReadGuard<'_, HashMap<String, FeedSubscriptionMetadata>> =
            self.subscribed_feeds.read().await;
        let result: Vec<(String, FeedSubscriptionMetadata)> =
            feeds.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        result
    }

    pub async fn check_all_feeds(&mut self) -> HashMap<String, usize> {
        let mut results: HashMap<String, usize> = HashMap::new();

        let feeds: Vec<String> = {
            let feeds = self.subscribed_feeds.read().await;
            feeds.keys().cloned().collect()
        };

        for url in feeds {
            let feed = match self.fetch_feed(&url).await {
                Ok(f) => f,
                Err(_) => continue,
            };

            let mut new_items: usize = 0;
            {
                let mut items: tokio::sync::RwLockWriteGuard<
                    '_,
                    HashMap<String, FeedItemMetadata>,
                > = self.feed_items.write().await;
                for item in &feed.items {
                    let item_id =
                        format!("{}_{}_{}", url, item.guid.as_str(), item.pub_date.as_str());

                    if let std::collections::hash_map::Entry::Vacant(e) = items.entry(item_id) {
                        e.insert(FeedItemMetadata::from_item(item, &url, feed.title()));
                        new_items += 1;
                    }
                }
            }

            {
                let mut subs: tokio::sync::RwLockWriteGuard<
                    '_,
                    HashMap<String, FeedSubscriptionMetadata>,
                > = self.subscribed_feeds.write().await;
                if let Some(meta) = subs.get_mut(&url) {
                    meta.last_checked = chrono::Utc::now().timestamp_millis();
                    meta.last_item_count = feed.items.len();
                }
            }

            results.insert(url, new_items);
        }

        results
    }

    pub async fn get_feed_items(&self, limit: usize) -> Vec<FeedItemMetadata> {
        let items: tokio::sync::RwLockReadGuard<'_, HashMap<String, FeedItemMetadata>> =
            self.feed_items.read().await;
        let mut result: Vec<FeedItemMetadata> = items.values().cloned().collect();
        result.sort_by(|a, b| {
            let a_date = a.pub_date.as_deref().unwrap_or("");
            let b_date = b.pub_date.as_deref().unwrap_or("");
            b_date.cmp(a_date)
        });

        result.truncate(limit);
        result
    }

    pub async fn format_feed_items(&self, items: Option<Vec<FeedItemMetadata>>) -> String {
        let items: Vec<FeedItemMetadata> = match items {
            Some(i) => i,
            None => self.get_feed_items(50).await,
        };

        if items.is_empty() {
            return "No RSS feed items available.".to_string();
        }

        let mut by_feed: HashMap<String, Vec<&FeedItemMetadata>> = HashMap::new();
        for item in &items {
            let feed_title = item.feed_title.as_deref().unwrap_or("Unknown Feed");
            by_feed
                .entry(feed_title.to_string())
                .or_default()
                .push(item);
        }

        match self.config.feed_format {
            FeedFormat::Markdown => self.format_markdown(&items, &by_feed),
            FeedFormat::Csv => self.format_csv(&items, &by_feed),
        }
    }

    fn format_markdown(
        &self,
        items: &[FeedItemMetadata],
        by_feed: &HashMap<String, Vec<&FeedItemMetadata>>,
    ) -> String {
        let mut output = format!(
            "# Recent RSS Feed Items ({} items from {} feeds)\n\n",
            items.len(),
            by_feed.len()
        );

        for (feed_title, feed_items) in by_feed {
            output.push_str(&format!(
                "## {} ({} items)\n\n",
                feed_title,
                feed_items.len()
            ));

            for item in feed_items {
                let title = item.title.as_deref().unwrap_or("Untitled");
                output.push_str(&format!("### {}\n", title));

                if let Some(ref link) = item.link {
                    output.push_str(&format!("- URL: {}\n", link));
                }
                if let Some(ref pub_date) = item.pub_date {
                    output.push_str(&format!("- Published: {}\n", pub_date));
                }
                if let Some(author) = &item.author {
                    if !author.is_empty() {
                        output.push_str(&format!("- Author: {}\n", author));
                    }
                }
                if let Some(desc) = &item.description {
                    let short_desc: String = if desc.len() > 200 {
                        format!("{}...", &desc[..200])
                    } else {
                        desc.clone()
                    };
                    output.push_str(&format!("- Description: {}\n", short_desc));
                }
                output.push('\n');
            }
        }

        output
    }

    fn format_csv(
        &self,
        items: &[FeedItemMetadata],
        by_feed: &HashMap<String, Vec<&FeedItemMetadata>>,
    ) -> String {
        let mut output = format!(
            "# RSS Feed Items ({} from {} feeds)\n",
            items.len(),
            by_feed.len()
        );
        output.push_str("Feed,Title,URL,Published,Description\n");

        for item in items {
            let feed = item
                .feed_title
                .as_deref()
                .unwrap_or("Unknown")
                .replace('"', "\"\"");
            let title = item.title.as_deref().unwrap_or("").replace('"', "\"\"");
            let url = item.link.as_deref().unwrap_or("");
            let pub_date = item.pub_date.as_deref().unwrap_or("");
            let desc = item.description.as_deref().unwrap_or("");
            let short_desc = if desc.len() > 200 { &desc[..200] } else { desc };
            let escaped_desc = short_desc.replace('"', "\"\"");

            output.push_str(&format!(
                "\"{}\",\"{}\",\"{}\",\"{}\",\"{}\"\n",
                feed, title, url, pub_date, escaped_desc
            ));
        }

        output
    }

    pub fn config(&self) -> &RssConfig {
        &self.config
    }
}

pub fn create_plugin(config: RssConfig) -> RssPlugin {
    RssPlugin::new(config)
}

pub fn get_rss_plugin() -> RssPlugin {
    RssPlugin::default_plugin()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_plugin_creation() {
        let plugin = RssPlugin::default_plugin();
        assert!(plugin.config.feeds.is_empty());
    }

    #[tokio::test]
    async fn test_subscribe_unsubscribe() {
        let mut plugin = RssPlugin::default_plugin();

        // Subscribe (will fail to fetch but should still subscribe)
        let _ = plugin
            .subscribe_feed("https://example.com/feed.rss", Some("Test Feed"))
            .await;

        let feeds = plugin.get_subscribed_feeds().await;
        assert_eq!(feeds.len(), 1);

        // Unsubscribe
        plugin
            .unsubscribe_feed("https://example.com/feed.rss")
            .await
            .unwrap();

        let feeds = plugin.get_subscribed_feeds().await;
        assert!(feeds.is_empty());
    }
}
