#![allow(missing_docs)]

use crate::config::FarcasterConfig;
use crate::error::{FarcasterError, Result};
use crate::types::{
    Cast, CastEmbed, CastId, CastParent, CastStats, EmbedType, FidRequest, Profile,
};
use chrono::{DateTime, Utc};
use regex::Regex;
use reqwest::Client;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::RwLock;

const NEYNAR_API_URL: &str = "https://api.neynar.com/v2";

fn parse_embed_type(embed: &Value) -> EmbedType {
    if embed.get("cast").is_some() || embed.get("cast_id").is_some() {
        return EmbedType::Cast;
    }
    if let Some(url) = embed.get("url").and_then(|v| v.as_str()) {
        let url_lower = url.to_lowercase();
        if url_lower.contains(".jpg")
            || url_lower.contains(".jpeg")
            || url_lower.contains(".png")
            || url_lower.contains(".gif")
            || url_lower.contains(".webp")
        {
            return EmbedType::Image;
        }
        if url_lower.contains(".mp4") || url_lower.contains(".webm") || url_lower.contains(".mov") {
            return EmbedType::Video;
        }
        if url_lower.contains(".mp3") || url_lower.contains(".wav") || url_lower.contains(".ogg") {
            return EmbedType::Audio;
        }
        return EmbedType::Url;
    }
    EmbedType::Unknown
}

fn neynar_cast_to_cast(neynar_cast: &Value) -> Cast {
    let author = neynar_cast.get("author").unwrap_or(&Value::Null);

    let profile = Profile {
        fid: author.get("fid").and_then(|v| v.as_u64()).unwrap_or(0),
        name: author
            .get("display_name")
            .and_then(|v| v.as_str())
            .unwrap_or("anon")
            .to_string(),
        username: author
            .get("username")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        pfp: author
            .get("pfp_url")
            .and_then(|v| v.as_str())
            .map(String::from),
        bio: author
            .get("profile")
            .and_then(|p| p.get("bio"))
            .and_then(|b| b.get("text"))
            .and_then(|v| v.as_str())
            .map(String::from),
        url: None,
    };

    let embeds: Vec<CastEmbed> = neynar_cast
        .get("embeds")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|embed_data| CastEmbed {
                    embed_type: parse_embed_type(embed_data),
                    url: embed_data
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    cast_hash: embed_data
                        .get("cast_id")
                        .and_then(|c| c.get("hash"))
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    metadata: None,
                })
                .collect()
        })
        .unwrap_or_default();

    let in_reply_to = neynar_cast
        .get("parent_hash")
        .and_then(|v| v.as_str())
        .and_then(|hash| {
            neynar_cast
                .get("parent_author")
                .and_then(|p| p.get("fid"))
                .and_then(|v| v.as_u64())
                .map(|fid| CastParent {
                    hash: hash.to_string(),
                    fid,
                })
        });

    let reactions = neynar_cast.get("reactions").unwrap_or(&Value::Null);
    let stats = CastStats {
        recasts: reactions
            .get("recasts_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        replies: neynar_cast
            .get("replies")
            .and_then(|r| r.get("count"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        likes: reactions
            .get("likes_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
    };

    let timestamp = neynar_cast
        .get("timestamp")
        .and_then(|v| v.as_str())
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);

    Cast {
        hash: neynar_cast
            .get("hash")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        author_fid: author.get("fid").and_then(|v| v.as_u64()).unwrap_or(0),
        text: neynar_cast
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        profile,
        timestamp,
        thread_id: neynar_cast
            .get("thread_hash")
            .and_then(|v| v.as_str())
            .map(String::from),
        in_reply_to,
        stats: Some(stats),
        embeds,
    }
}

/// Split post content into chunks that fit within the max length.
pub fn split_post_content(content: &str, max_length: usize) -> Vec<String> {
    let paragraphs: Vec<&str> = content
        .split("\n\n")
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();

    let mut posts: Vec<String> = Vec::new();
    let mut current_cast = String::new();

    for paragraph in paragraphs {
        let test_cast = if current_cast.is_empty() {
            paragraph.to_string()
        } else {
            format!("{}\n\n{}", current_cast, paragraph)
        };

        if test_cast.len() <= max_length {
            current_cast = test_cast;
        } else {
            if !current_cast.is_empty() {
                posts.push(current_cast.clone());
            }
            if paragraph.len() <= max_length {
                current_cast = paragraph.to_string();
            } else {
                let chunks = split_paragraph(paragraph, max_length);
                if chunks.len() > 1 {
                    posts.extend(chunks[..chunks.len() - 1].iter().cloned());
                    current_cast = chunks.last().cloned().unwrap_or_default();
                } else if !chunks.is_empty() {
                    current_cast = chunks[0].clone();
                }
            }
        }
    }

    if !current_cast.is_empty() {
        posts.push(current_cast);
    }

    posts
}

fn split_paragraph(paragraph: &str, max_length: usize) -> Vec<String> {
    let sentence_re = Regex::new(r"[^.!?]+[.!?]+|[^.!?]+$").unwrap();
    let sentences: Vec<&str> = sentence_re
        .find_iter(paragraph)
        .map(|m| m.as_str())
        .collect();

    let sentences = if sentences.is_empty() {
        vec![paragraph]
    } else {
        sentences
    };

    let mut chunks: Vec<String> = Vec::new();
    let mut current_chunk = String::new();

    for sentence in sentences {
        let test_chunk = if current_chunk.is_empty() {
            sentence.to_string()
        } else {
            format!("{} {}", current_chunk, sentence)
        };

        if test_chunk.len() <= max_length {
            current_chunk = test_chunk;
        } else {
            if !current_chunk.is_empty() {
                chunks.push(current_chunk.trim().to_string());
            }
            if sentence.len() <= max_length {
                current_chunk = sentence.to_string();
            } else {
                let words: Vec<&str> = sentence.split_whitespace().collect();
                current_chunk.clear();
                for word in words {
                    let test_word = if current_chunk.is_empty() {
                        word.to_string()
                    } else {
                        format!("{} {}", current_chunk, word)
                    };
                    if test_word.len() <= max_length {
                        current_chunk = test_word;
                    } else {
                        if !current_chunk.is_empty() {
                            chunks.push(current_chunk.trim().to_string());
                        }
                        // If word is too long, split by characters
                        if word.len() > max_length {
                            let word_chunks = split_by_chars(word, max_length);
                            if word_chunks.len() > 1 {
                                chunks.extend(word_chunks[..word_chunks.len() - 1].iter().cloned());
                                current_chunk = word_chunks.last().cloned().unwrap_or_default();
                            } else if !word_chunks.is_empty() {
                                current_chunk = word_chunks[0].clone();
                            }
                        } else {
                            current_chunk = word.to_string();
                        }
                    }
                }
            }
        }
    }

    if !current_chunk.is_empty() {
        chunks.push(current_chunk.trim().to_string());
    }

    chunks
}

/// Split a string by character boundaries when it exceeds max length.
fn split_by_chars(text: &str, max_length: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        if current.len() + ch.len_utf8() > max_length {
            if !current.is_empty() {
                chunks.push(current);
            }
            current = String::new();
        }
        current.push(ch);
    }

    if !current.is_empty() {
        chunks.push(current);
    }

    chunks
}

/// Farcaster client for interacting with the Neynar API.
///
/// Provides methods for sending casts, fetching profiles, and retrieving timeline.
pub struct FarcasterClient {
    config: FarcasterConfig,
    http_client: Client,
    profile_cache: RwLock<HashMap<u64, Profile>>,
    cast_cache: RwLock<HashMap<String, Cast>>,
}

impl FarcasterClient {
    pub fn new(config: FarcasterConfig) -> Result<Self> {
        config.validate()?;

        let http_client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(FarcasterError::Network)?;

        Ok(Self {
            config,
            http_client,
            profile_cache: RwLock::new(HashMap::new()),
            cast_cache: RwLock::new(HashMap::new()),
        })
    }

    /// Get the configuration.
    pub fn config(&self) -> &FarcasterConfig {
        &self.config
    }

    /// Make an HTTP request to the Neynar API.
    async fn make_request(
        &self,
        method: reqwest::Method,
        endpoint: &str,
        query: Option<&[(&str, &str)]>,
        json_body: Option<&Value>,
    ) -> Result<Value> {
        let url = format!("{}{}", NEYNAR_API_URL, endpoint);

        let mut request = self
            .http_client
            .request(method, &url)
            .header("api_key", &self.config.neynar_api_key)
            .header("Content-Type", "application/json");

        if let Some(q) = query {
            request = request.query(q);
        }

        if let Some(body) = json_body {
            request = request.json(body);
        }

        let response = request.send().await.map_err(FarcasterError::Network)?;

        let status = response.status();

        if status.as_u16() == 429 {
            let retry_after = response
                .headers()
                .get("Retry-After")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse().ok());
            return Err(FarcasterError::rate_limit(retry_after));
        }

        if !status.is_success() {
            let error_body: Value = response.json().await.unwrap_or_default();
            return Err(FarcasterError::api(
                error_body
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&format!("API error: {}", status)),
                Some(status.as_u16()),
                error_body
                    .get("code")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            ));
        }

        response.json().await.map_err(FarcasterError::Network)
    }

    pub async fn send_cast(&self, text: &str, in_reply_to: Option<CastId>) -> Result<Vec<Cast>> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(vec![]);
        }

        if self.config.dry_run {
            let fake_cast = Cast {
                hash: "dry_run_hash".to_string(),
                author_fid: self.config.fid,
                text: text.to_string(),
                profile: Profile::new(self.config.fid, "dry_run".to_string()),
                timestamp: Utc::now(),
                thread_id: None,
                in_reply_to: None,
                stats: None,
                embeds: vec![],
            };
            return Ok(vec![fake_cast]);
        }

        let chunks = split_post_content(text, self.config.max_cast_length);
        let mut sent: Vec<Cast> = Vec::new();

        for chunk in chunks {
            let cast = self.publish_cast(&chunk, in_reply_to.as_ref()).await?;
            sent.push(cast);
        }

        Ok(sent)
    }

    async fn publish_cast(&self, text: &str, parent_cast_id: Option<&CastId>) -> Result<Cast> {
        let mut payload = serde_json::json!({
            "signer_uuid": self.config.signer_uuid,
            "text": text,
        });

        if let Some(parent) = parent_cast_id {
            payload["parent"] = serde_json::json!(parent.hash);
        }

        let result = self
            .make_request(
                reqwest::Method::POST,
                "/farcaster/cast",
                None,
                Some(&payload),
            )
            .await?;

        if !result
            .get("success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return Err(FarcasterError::cast(format!(
                "Failed to publish cast: {}",
                &text[..text.len().min(50)]
            )));
        }

        if let Some(hash) = result
            .get("cast")
            .and_then(|c| c.get("hash"))
            .and_then(|v| v.as_str())
        {
            return self.get_cast(hash).await;
        }

        Ok(Cast {
            hash: String::new(),
            author_fid: self.config.fid,
            text: text.to_string(),
            profile: Profile::new(self.config.fid, String::new()),
            timestamp: Utc::now(),
            thread_id: None,
            in_reply_to: None,
            stats: None,
            embeds: vec![],
        })
    }

    pub async fn get_cast(&self, cast_hash: &str) -> Result<Cast> {
        {
            let cache = self
                .cast_cache
                .read()
                .map_err(|_| FarcasterError::cast("Cache lock error"))?;
            if let Some(cast) = cache.get(cast_hash) {
                return Ok(cast.clone());
            }
        }

        let result: Value = self
            .make_request(
                reqwest::Method::GET,
                "/farcaster/cast",
                Some(&[("identifier", cast_hash), ("type", "hash")]),
                None,
            )
            .await?;

        let cast: Cast = result
            .get("cast")
            .map(neynar_cast_to_cast)
            .ok_or_else(|| FarcasterError::cast("Cast not found"))?;

        if let Ok(mut cache) = self.cast_cache.write() {
            let cache: &mut HashMap<String, Cast> = &mut cache;
            cache.insert(cast_hash.to_string(), cast.clone());
        }

        Ok(cast)
    }

    pub async fn get_mentions(&self, request: &FidRequest) -> Result<Vec<Cast>> {
        let result = self
            .make_request(
                reqwest::Method::GET,
                "/farcaster/notifications",
                Some(&[
                    ("fid", &request.fid.to_string()),
                    ("type", "mentions,replies"),
                    ("limit", &request.page_size.to_string()),
                ]),
                None,
            )
            .await?;

        let mentions: Vec<Cast> = result
            .get("notifications")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|n| n.get("cast").map(neynar_cast_to_cast))
                    .collect()
            })
            .unwrap_or_default();

        Ok(mentions)
    }

    pub async fn get_profile(&self, fid: u64) -> Result<Profile> {
        {
            let cache = self
                .profile_cache
                .read()
                .map_err(|_| FarcasterError::profile("Cache lock error"))?;
            if let Some(profile) = cache.get(&fid) {
                return Ok(profile.clone());
            }
        }

        let result: Value = self
            .make_request(
                reqwest::Method::GET,
                "/farcaster/user/bulk",
                Some(&[("fids", &fid.to_string())]),
                None,
            )
            .await?;

        let users = result
            .get("users")
            .and_then(|v| v.as_array())
            .ok_or_else(|| FarcasterError::profile("User not found"))?;

        if users.is_empty() {
            return Err(FarcasterError::profile(format!("User not found: {}", fid)));
        }

        let user = &users[0];
        let profile = Profile {
            fid,
            name: user
                .get("display_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            username: user
                .get("username")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            bio: user
                .get("profile")
                .and_then(|p| p.get("bio"))
                .and_then(|b| b.get("text"))
                .and_then(|v| v.as_str())
                .map(String::from),
            pfp: user
                .get("pfp_url")
                .and_then(|v| v.as_str())
                .map(String::from),
            url: None,
        };

        if let Ok(mut cache) = self.profile_cache.write() {
            let cache: &mut HashMap<u64, Profile> = &mut cache;
            cache.insert(fid, profile.clone());
        }

        Ok(profile)
    }

    pub async fn get_timeline(&self, request: &FidRequest) -> Result<(Vec<Cast>, Option<String>)> {
        let result = self
            .make_request(
                reqwest::Method::GET,
                "/farcaster/feed/user/casts",
                Some(&[
                    ("fid", &request.fid.to_string()),
                    ("limit", &request.page_size.to_string()),
                ]),
                None,
            )
            .await?;

        let timeline: Vec<Cast> = result
            .get("casts")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|c| {
                        let cast: Cast = neynar_cast_to_cast(c);
                        if let Ok(mut cache) = self.cast_cache.write() {
                            let cache: &mut HashMap<String, Cast> = &mut cache;
                            cache.insert(cast.hash.clone(), cast.clone());
                        }
                        cast
                    })
                    .collect()
            })
            .unwrap_or_default();

        let next_cursor = result
            .get("next")
            .and_then(|n| n.get("cursor"))
            .and_then(|v| v.as_str())
            .map(String::from);

        Ok((timeline, next_cursor))
    }

    pub fn clear_cache(&self) {
        if let Ok(mut cache) = self.profile_cache.write() {
            let cache: &mut HashMap<u64, Profile> = &mut cache;
            cache.clear();
        }
        if let Ok(mut cache) = self.cast_cache.write() {
            let cache: &mut HashMap<String, Cast> = &mut cache;
            cache.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_post_content_short() {
        let text = "This is a short message.";
        let chunks = split_post_content(text, 320);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], text);
    }

    #[test]
    fn test_split_post_content_long() {
        let text = "A".repeat(400);
        let chunks = split_post_content(&text, 320);
        assert_eq!(chunks.len(), 2);
        assert!(chunks.iter().all(|c| c.len() <= 320));
    }

    #[test]
    fn test_split_post_content_paragraphs() {
        let text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
        let chunks = split_post_content(text, 320);
        assert_eq!(chunks.len(), 1);
    }

    #[test]
    fn test_parse_embed_type() {
        let image = serde_json::json!({"url": "https://example.com/image.jpg"});
        assert_eq!(parse_embed_type(&image), EmbedType::Image);

        let video = serde_json::json!({"url": "https://example.com/video.mp4"});
        assert_eq!(parse_embed_type(&video), EmbedType::Video);

        let url = serde_json::json!({"url": "https://example.com"});
        assert_eq!(parse_embed_type(&url), EmbedType::Url);

        let cast = serde_json::json!({"cast_id": {"hash": "0xabc"}});
        assert_eq!(parse_embed_type(&cast), EmbedType::Cast);
    }
}
