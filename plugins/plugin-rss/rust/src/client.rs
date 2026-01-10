//! RSS Client
//!
//! Async HTTP client for fetching and parsing RSS/Atom feeds.

use std::time::Duration;

use regex::Regex;
use reqwest::Client;

use crate::error::{Result, RssError};
use crate::parser::parse_rss_to_json;
use crate::types::{RssConfig, RssFeed};

/// Async RSS feed client.
///
/// Fetches and parses RSS/Atom feeds using reqwest.
pub struct RssClient {
    config: RssConfig,
    http: Client,
}

impl RssClient {
    /// Create a new RSS client.
    ///
    /// # Arguments
    ///
    /// * `config` - Client configuration
    pub fn new(config: RssConfig) -> Result<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(config.timeout_secs))
            .user_agent(&config.user_agent)
            .build()
            .map_err(RssError::Http)?;

        Ok(Self { config, http })
    }

    /// Create a client with default configuration.
    pub fn default_client() -> Result<Self> {
        Self::new(RssConfig::default())
    }

    /// Fetch and parse an RSS/Atom feed.
    ///
    /// # Arguments
    ///
    /// * `url` - The feed URL to fetch
    pub async fn fetch_feed(&self, url: &str) -> Result<RssFeed> {
        let response = self
            .http
            .get(url)
            .header("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml, */*")
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            return Err(RssError::InvalidFeed(format!(
                "HTTP error {}: {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown")
            )));
        }

        let content = response.text().await?;
        if content.is_empty() {
            return Err(RssError::InvalidFeed("Empty response".to_string()));
        }

        parse_rss_to_json(&content)
    }

    /// Fetch a feed, returning None on error.
    ///
    /// # Arguments
    ///
    /// * `url` - The feed URL to fetch
    pub async fn fetch_feed_safe(&self, url: &str) -> Option<RssFeed> {
        self.fetch_feed(url).await.ok()
    }

    /// Validate that a URL points to a valid RSS/Atom feed.
    ///
    /// # Arguments
    ///
    /// * `url` - The URL to validate
    ///
    /// # Returns
    ///
    /// Tuple of (is_valid, message)
    pub async fn validate_feed(&self, url: &str) -> (bool, String) {
        match self.fetch_feed(url).await {
            Ok(feed) => {
                if !feed.title().is_empty() {
                    (true, format!("Valid feed: {}", feed.title()))
                } else {
                    (true, "Valid feed (no title)".to_string())
                }
            }
            Err(e) => (false, e.to_string()),
        }
    }

    /// Get the client configuration.
    pub fn config(&self) -> &RssConfig {
        &self.config
    }
}

/// Extract all URLs from a block of text.
///
/// - Supports http(s)://, ftp://, and schemeless "www." links
/// - Strips trailing punctuation
/// - Normalizes and deduplicates results
///
/// # Arguments
///
/// * `text` - The text to extract URLs from
pub fn extract_urls(text: &str) -> Vec<String> {
    let url_pattern = Regex::new(r#"(?i)(?:(?:https?|ftp)://|www\.)[^\s<>"'`]+"#).unwrap();
    let trailing_punct = Regex::new(r#"[)\]}>,.;!?:'"…]$"#).unwrap();

    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for cap in url_pattern.find_iter(text) {
        let mut candidate = cap.as_str().to_string();

        // Trim leading wrappers
        candidate = candidate.trim_start_matches(|c: char| "([{<'\"".contains(c)).to_string();

        // Add scheme if missing
        let mut with_scheme = if candidate.starts_with("www.") {
            format!("http://{}", candidate)
        } else {
            candidate
        };

        // Trim trailing punctuation
        while trailing_punct.is_match(&with_scheme) {
            if is_valid_url(&with_scheme) {
                break;
            }
            with_scheme.pop();
        }

        if !is_valid_url(&with_scheme) {
            continue;
        }

        // Normalize
        if let Ok(parsed) = url::Url::parse(&with_scheme) {
            let normalized = parsed.to_string();
            if !seen.contains(&normalized) {
                seen.insert(normalized.clone());
                results.push(normalized);
            }
        }
    }

    results
}

/// Check if a string is a valid URL.
fn is_valid_url(url: &str) -> bool {
    url::Url::parse(url).is_ok()
}

/// Format a relative time string (e.g., "5 minutes ago").
///
/// # Arguments
///
/// * `timestamp_ms` - Timestamp in milliseconds
pub fn format_relative_time(timestamp_ms: i64) -> String {
    let now = chrono::Utc::now().timestamp_millis();
    let time_since = now - timestamp_ms;
    let minutes_since = time_since / 60000;
    let hours_since = minutes_since / 60;
    let days_since = hours_since / 24;

    if days_since > 0 {
        format!("{} day{} ago", days_since, if days_since > 1 { "s" } else { "" })
    } else if hours_since > 0 {
        format!("{} hour{} ago", hours_since, if hours_since > 1 { "s" } else { "" })
    } else if minutes_since > 0 {
        format!("{} minute{} ago", minutes_since, if minutes_since > 1 { "s" } else { "" })
    } else {
        "just now".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_http_urls() {
        let text = "Check out https://example.com and http://test.com for more.";
        let urls = extract_urls(text);

        assert_eq!(urls.len(), 2);
        assert!(urls.iter().any(|u| u.contains("example.com")));
        assert!(urls.iter().any(|u| u.contains("test.com")));
    }

    #[test]
    fn test_extract_www_urls() {
        let text = "Visit www.example.com for details.";
        let urls = extract_urls(text);

        assert_eq!(urls.len(), 1);
        assert!(urls[0].starts_with("http://www.example.com"));
    }

    #[test]
    fn test_extract_no_urls() {
        let text = "This text has no URLs.";
        let urls = extract_urls(text);

        assert!(urls.is_empty());
    }

    #[test]
    fn test_format_relative_time_minutes() {
        let now = chrono::Utc::now().timestamp_millis();
        let five_mins_ago = now - 5 * 60 * 1000;

        let result = format_relative_time(five_mins_ago);
        assert!(result.contains("5 minute"));
    }

    #[test]
    fn test_format_relative_time_just_now() {
        let now = chrono::Utc::now().timestamp_millis();
        let thirty_secs_ago = now - 30 * 1000;

        let result = format_relative_time(thirty_secs_ago);
        assert_eq!(result, "just now");
    }
}

