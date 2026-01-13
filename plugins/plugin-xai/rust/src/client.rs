#![allow(missing_docs)]

use base64::Engine;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use rand::Rng;
use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE},
    Client, Response,
};
use sha1::Sha1;
use std::collections::HashMap;
use std::time::Duration;
use tracing::debug;

use crate::error::{Result, XAIError};
use crate::types::*;

pub struct TwitterClient {
    client: Client,
    config: TwitterConfig,
    me: Option<Profile>,
}

impl TwitterClient {
    const API_BASE: &'static str = "https://api.x.com/2";

    pub fn new(config: TwitterConfig) -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()?;

        Ok(Self {
            client,
            config,
            me: None,
        })
    }

    fn generate_nonce() -> String {
        let nonce: u64 = rand::thread_rng().gen();
        base64::engine::general_purpose::STANDARD.encode(nonce.to_string())
    }

    fn generate_signature(
        &self,
        method: &str,
        url: &str,
        params: &HashMap<String, String>,
        oauth_params: &HashMap<String, String>,
    ) -> String {
        let mut all_params: Vec<_> = params
            .iter()
            .chain(oauth_params.iter())
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        all_params.sort_by(|a, b| a.0.cmp(b.0));

        let param_string: String = all_params
            .iter()
            .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
            .collect::<Vec<_>>()
            .join("&");

        let base_string = format!(
            "{}&{}&{}",
            method.to_uppercase(),
            urlencoding::encode(url),
            urlencoding::encode(&param_string)
        );

        let signing_key = format!(
            "{}&{}",
            urlencoding::encode(&self.config.api_secret),
            urlencoding::encode(&self.config.access_token_secret)
        );

        let mut mac =
            Hmac::<Sha1>::new_from_slice(signing_key.as_bytes()).expect("HMAC can take any size");
        mac.update(base_string.as_bytes());
        let result = mac.finalize();

        base64::engine::general_purpose::STANDARD.encode(result.into_bytes())
    }

    fn get_oauth_header(
        &self,
        method: &str,
        url: &str,
        params: &HashMap<String, String>,
    ) -> String {
        let timestamp = Utc::now().timestamp().to_string();
        let nonce = Self::generate_nonce();

        let mut oauth_params: HashMap<String, String> = HashMap::new();
        oauth_params.insert(
            "oauth_consumer_key".to_string(),
            self.config.api_key.clone(),
        );
        oauth_params.insert("oauth_nonce".to_string(), nonce);
        oauth_params.insert(
            "oauth_signature_method".to_string(),
            "HMAC-SHA1".to_string(),
        );
        oauth_params.insert("oauth_timestamp".to_string(), timestamp);
        oauth_params.insert("oauth_token".to_string(), self.config.access_token.clone());
        oauth_params.insert("oauth_version".to_string(), "1.0".to_string());

        let signature = self.generate_signature(method, url, params, &oauth_params);
        oauth_params.insert("oauth_signature".to_string(), signature);

        let mut sorted_params: Vec<_> = oauth_params.iter().collect();
        sorted_params.sort_by(|a, b| a.0.cmp(b.0));

        let header_parts: Vec<String> = sorted_params
            .iter()
            .map(|(k, v)| format!("{}=\"{}\"", k, urlencoding::encode(v)))
            .collect();

        format!("OAuth {}", header_parts.join(", "))
    }

    fn get_headers(&self, method: &str, url: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let oauth_header = self.get_oauth_header(method, url, &HashMap::new());
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&oauth_header).expect("Valid OAuth header"),
        );

        headers
    }

    async fn check_response(&self, response: Response) -> Result<Response> {
        if response.status().is_success() {
            return Ok(response);
        }

        let status = response.status().as_u16();
        let text = response.text().await?;

        let message = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                v["detail"]
                    .as_str()
                    .or(v["title"].as_str())
                    .map(String::from)
            })
            .unwrap_or(text);

        Err(XAIError::TwitterApiError { status, message })
    }

    fn url(&self, endpoint: &str) -> String {
        format!("{}{}", Self::API_BASE, endpoint)
    }

    pub async fn me(&mut self) -> Result<Profile> {
        if let Some(ref profile) = self.me {
            return Ok(profile.clone());
        }

        let url = self.url("/users/me");
        let headers = self.get_headers("GET", &url);

        let response = self
            .client
            .get(&url)
            .headers(headers)
            .query(&[("user.fields", "id,name,username,description,location,url,profile_image_url,verified,protected,created_at,public_metrics")])
            .send()
            .await?;

        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        let user = &data["data"];
        let metrics = &user["public_metrics"];

        let profile = Profile {
            id: user["id"].as_str().unwrap_or("").to_string(),
            username: user["username"].as_str().unwrap_or("").to_string(),
            name: user["name"].as_str().unwrap_or("").to_string(),
            description: user["description"].as_str().map(String::from),
            location: user["location"].as_str().map(String::from),
            url: user["url"].as_str().map(String::from),
            profile_image_url: user["profile_image_url"].as_str().map(String::from),
            verified: user["verified"].as_bool().unwrap_or(false),
            protected: user["protected"].as_bool().unwrap_or(false),
            followers_count: metrics["followers_count"].as_u64().unwrap_or(0),
            following_count: metrics["following_count"].as_u64().unwrap_or(0),
            post_count: metrics["post_count"].as_u64().unwrap_or(0),
            listed_count: metrics["listed_count"].as_u64().unwrap_or(0),
            created_at: user["created_at"]
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&Utc)),
        };

        self.me = Some(profile.clone());
        Ok(profile)
    }

    /// Get a user's profile by username.
    pub async fn get_profile(&self, username: &str) -> Result<Profile> {
        let url = self.url(&format!("/users/by/username/{}", username));
        let headers = self.get_headers("GET", &url);

        let response = self
            .client
            .get(&url)
            .headers(headers)
            .query(&[("user.fields", "id,name,username,description,location,url,profile_image_url,verified,protected,created_at,public_metrics")])
            .send()
            .await?;

        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        let user = &data["data"];
        let metrics = &user["public_metrics"];

        Ok(Profile {
            id: user["id"].as_str().unwrap_or("").to_string(),
            username: user["username"].as_str().unwrap_or("").to_string(),
            name: user["name"].as_str().unwrap_or("").to_string(),
            description: user["description"].as_str().map(String::from),
            location: user["location"].as_str().map(String::from),
            url: user["url"].as_str().map(String::from),
            profile_image_url: user["profile_image_url"].as_str().map(String::from),
            verified: user["verified"].as_bool().unwrap_or(false),
            protected: user["protected"].as_bool().unwrap_or(false),
            followers_count: metrics["followers_count"].as_u64().unwrap_or(0),
            following_count: metrics["following_count"].as_u64().unwrap_or(0),
            post_count: metrics["post_count"].as_u64().unwrap_or(0),
            listed_count: metrics["listed_count"].as_u64().unwrap_or(0),
            created_at: user["created_at"]
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&Utc)),
        })
    }

    pub async fn get_user_id(&self, username: &str) -> Result<String> {
        let profile = self.get_profile(username).await?;
        Ok(profile.id)
    }

    fn parse_profile(&self, user: &serde_json::Value) -> Result<Profile> {
        let metrics = &user["public_metrics"];
        Ok(Profile {
            id: user["id"]
                .as_str()
                .ok_or(XAIError::ParseError("Missing user id".to_string()))?
                .to_string(),
            username: user["username"]
                .as_str()
                .ok_or(XAIError::ParseError("Missing username".to_string()))?
                .to_string(),
            name: user["name"]
                .as_str()
                .ok_or(XAIError::ParseError("Missing name".to_string()))?
                .to_string(),
            description: user["description"].as_str().map(String::from),
            location: user["location"].as_str().map(String::from),
            url: user["url"].as_str().map(String::from),
            profile_image_url: user["profile_image_url"].as_str().map(String::from),
            verified: user["verified"].as_bool().unwrap_or(false),
            protected: user["protected"].as_bool().unwrap_or(false),
            followers_count: metrics["followers_count"].as_u64().unwrap_or(0),
            following_count: metrics["following_count"].as_u64().unwrap_or(0),
            post_count: metrics["post_count"].as_u64().unwrap_or(0),
            listed_count: metrics["listed_count"].as_u64().unwrap_or(0),
            created_at: user["created_at"]
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&Utc)),
        })
    }

    fn parse_post(&self, post_data: &serde_json::Value, includes: &serde_json::Value) -> Post {
        let users: HashMap<String, &serde_json::Value> = includes["users"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|u| u["id"].as_str().map(|id| (id.to_string(), u)))
                    .collect()
            })
            .unwrap_or_default();

        let media: HashMap<String, &serde_json::Value> = includes["media"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m["media_key"].as_str().map(|key| (key.to_string(), m)))
                    .collect()
            })
            .unwrap_or_default();

        let author = post_data["author_id"]
            .as_str()
            .and_then(|id| users.get(id))
            .cloned();

        let metrics = &post_data["public_metrics"];
        let entities = &post_data["entities"];
        let attachments = &post_data["attachments"];

        let mut photos: Vec<Photo> = Vec::new();
        let mut videos: Vec<Video> = Vec::new();

        if let Some(keys) = attachments["media_keys"].as_array() {
            for key_val in keys {
                if let Some(key) = key_val.as_str() {
                    if let Some(m) = media.get(key) {
                        match m["type"].as_str() {
                            Some("photo") => {
                                photos.push(Photo {
                                    id: key.to_string(),
                                    url: m["url"].as_str().unwrap_or("").to_string(),
                                    alt_text: m["alt_text"].as_str().map(String::from),
                                });
                            }
                            Some("video") | Some("animated_gif") => {
                                let url = m["variants"]
                                    .as_array()
                                    .and_then(|arr| {
                                        arr.iter()
                                            .find(|v| {
                                                v["content_type"].as_str() == Some("video/mp4")
                                            })
                                            .and_then(|v| v["url"].as_str())
                                    })
                                    .map(String::from);

                                videos.push(Video {
                                    id: key.to_string(),
                                    preview: m["preview_image_url"]
                                        .as_str()
                                        .unwrap_or("")
                                        .to_string(),
                                    url,
                                    duration_ms: m["duration_ms"].as_u64(),
                                });
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        // Parse referenced posts
        let refs = post_data["referenced_posts"].as_array();
        let is_reply = refs
            .map(|arr| arr.iter().any(|r| r["type"].as_str() == Some("replied_to")))
            .unwrap_or(false);
        let is_repost = refs
            .map(|arr| arr.iter().any(|r| r["type"].as_str() == Some("reposted")))
            .unwrap_or(false);
        let is_quote = refs
            .map(|arr| arr.iter().any(|r| r["type"].as_str() == Some("quoted")))
            .unwrap_or(false);

        let in_reply_to_id = refs
            .and_then(|arr| {
                arr.iter()
                    .find(|r| r["type"].as_str() == Some("replied_to"))
                    .and_then(|r| r["id"].as_str())
            })
            .map(String::from);

        let quoted_id = refs
            .and_then(|arr| {
                arr.iter()
                    .find(|r| r["type"].as_str() == Some("quoted"))
                    .and_then(|r| r["id"].as_str())
            })
            .map(String::from);

        let reposted_id = refs
            .and_then(|arr| {
                arr.iter()
                    .find(|r| r["type"].as_str() == Some("reposted"))
                    .and_then(|r| r["id"].as_str())
            })
            .map(String::from);

        let mentions: Vec<Mention> = entities["mentions"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .map(|m| Mention {
                        id: m["id"].as_str().unwrap_or("").to_string(),
                        username: m["username"].as_str().map(String::from),
                        name: None,
                    })
                    .collect()
            })
            .unwrap_or_default();

        let hashtags: Vec<String> = entities["hashtags"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|h| h["tag"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        // Parse URLs
        let urls: Vec<String> = entities["urls"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|u| u["url"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        let id = post_data["id"].as_str().unwrap_or("").to_string();
        let created_at = post_data["created_at"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc));

        Post {
            id: id.clone(),
            text: post_data["text"].as_str().unwrap_or("").to_string(),
            author_id: post_data["author_id"].as_str().map(String::from),
            conversation_id: post_data["conversation_id"].as_str().map(String::from),
            created_at,
            language: post_data["lang"].as_str().map(String::from),
            username: author
                .and_then(|a| a["username"].as_str())
                .unwrap_or("")
                .to_string(),
            name: author
                .and_then(|a| a["name"].as_str())
                .unwrap_or("")
                .to_string(),
            metrics: PostMetrics {
                like_count: metrics["like_count"].as_u64().unwrap_or(0),
                repost_count: metrics["repost_count"].as_u64().unwrap_or(0),
                reply_count: metrics["reply_count"].as_u64().unwrap_or(0),
                quote_count: metrics["quote_count"].as_u64().unwrap_or(0),
                impression_count: metrics["impression_count"].as_u64().unwrap_or(0),
                bookmark_count: metrics["bookmark_count"].as_u64().unwrap_or(0),
            },
            hashtags,
            mentions,
            urls,
            photos,
            videos,
            poll: None,
            place: None,
            in_reply_to_id,
            quoted_id,
            reposted_id,
            is_reply,
            is_repost,
            is_quote,
            is_sensitive: post_data["possibly_sensitive"].as_bool().unwrap_or(false),
            permanent_url: format!("https://x.com/i/status/{}", id),
            timestamp: created_at.map(|dt| dt.timestamp()).unwrap_or(0),
        }
    }

    pub async fn get_post(&self, post_id: &str) -> Result<Option<Post>> {
        let url = self.url(&format!("/posts/{}", post_id));
        let headers = self.get_headers("GET", &url);

        let response = self
            .client
            .get(&url)
            .headers(headers)
            .query(&[
                ("post.fields", "id,text,created_at,author_id,conversation_id,referenced_posts,entities,public_metrics,attachments,geo,lang,possibly_sensitive"),
                ("user.fields", "id,name,username,profile_image_url"),
                ("media.fields", "url,preview_image_url,type,variants,alt_text"),
                ("expansions", "author_id,attachments.media_keys,referenced_posts.id"),
            ])
            .send()
            .await?;

        match self.check_response(response).await {
            Ok(response) => {
                let data: serde_json::Value = response.json().await?;
                if data["data"].is_null() {
                    return Ok(None);
                }
                let includes = &data["includes"];
                Ok(Some(self.parse_post(&data["data"], includes)))
            }
            Err(XAIError::TwitterApiError { status: 404, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn create_post(&self, text: &str) -> Result<PostCreateResult> {
        if self.config.dry_run {
            debug!("Dry run: would post: {}", text);
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            return Ok(PostCreateResult {
                id: format!("dry-run-{}", nonce),
                text: text.to_string(),
            });
        }

        let url = self.url("/posts");
        let headers = self.get_headers("POST", &url);

        let body = serde_json::json!({ "text": text });

        let response = self
            .client
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await?;

        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        Ok(PostCreateResult {
            id: data["data"]["id"].as_str().unwrap_or("").to_string(),
            text: data["data"]["text"].as_str().unwrap_or(text).to_string(),
        })
    }

    pub async fn create_reply(&self, text: &str, reply_to_id: &str) -> Result<PostCreateResult> {
        if self.config.dry_run {
            debug!("Dry run: would reply to {}: {}", reply_to_id, text);
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            return Ok(PostCreateResult {
                id: format!("dry-run-{}", nonce),
                text: text.to_string(),
            });
        }

        let url = self.url("/posts");
        let headers = self.get_headers("POST", &url);

        let body = serde_json::json!({
            "text": text,
            "reply": {
                "in_reply_to_post_id": reply_to_id
            }
        });

        let response = self
            .client
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await?;

        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        Ok(PostCreateResult {
            id: data["data"]["id"].as_str().unwrap_or("").to_string(),
            text: data["data"]["text"].as_str().unwrap_or(text).to_string(),
        })
    }

    pub async fn delete_post(&self, post_id: &str) -> Result<bool> {
        if self.config.dry_run {
            debug!("Dry run: would delete post: {}", post_id);
            return Ok(true);
        }

        let url = self.url(&format!("/posts/{}", post_id));
        let headers = self.get_headers("DELETE", &url);

        let response = self.client.delete(&url).headers(headers).send().await?;
        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        Ok(data["data"]["deleted"].as_bool().unwrap_or(false))
    }

    pub async fn like_post(&mut self, post_id: &str) -> Result<bool> {
        if self.config.dry_run {
            debug!("Dry run: would like post: {}", post_id);
            return Ok(true);
        }

        let me = self.me().await?;
        let url = self.url(&format!("/users/{}/likes", me.id));
        let headers = self.get_headers("POST", &url);

        let body = serde_json::json!({ "post_id": post_id });

        let response = self
            .client
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await?;

        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        Ok(data["data"]["liked"].as_bool().unwrap_or(false))
    }

    pub async fn repost(&mut self, post_id: &str) -> Result<bool> {
        if self.config.dry_run {
            debug!("Dry run: would repost: {}", post_id);
            return Ok(true);
        }

        let me = self.me().await?;
        let url = self.url(&format!("/users/{}/reposts", me.id));
        let headers = self.get_headers("POST", &url);

        let body = serde_json::json!({ "post_id": post_id });

        let response = self
            .client
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await?;

        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        Ok(data["data"]["reposted"].as_bool().unwrap_or(false))
    }

    /// Unlike a post.
    pub async fn unlike_post(&mut self, post_id: &str) -> Result<bool> {
        if self.config.dry_run {
            debug!("Dry run: would unlike post: {}", post_id);
            return Ok(true);
        }

        let me = self.me().await?;
        let url = self.url(&format!("/users/{}/likes/{}", me.id, post_id));
        let headers = self.get_headers("DELETE", &url);

        let response = self.client.delete(&url).headers(headers).send().await?;
        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        Ok(!data["data"]["liked"].as_bool().unwrap_or(true))
    }

    pub async fn unrepost(&mut self, post_id: &str) -> Result<bool> {
        if self.config.dry_run {
            debug!("Dry run: would unrepost: {}", post_id);
            return Ok(true);
        }

        let me = self.me().await?;
        let url = self.url(&format!("/users/{}/reposts/{}", me.id, post_id));
        let headers = self.get_headers("DELETE", &url);

        let response = self.client.delete(&url).headers(headers).send().await?;
        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        Ok(!data["data"]["reposted"].as_bool().unwrap_or(true))
    }

    pub async fn follow_user(&mut self, user_id: &str) -> Result<bool> {
        if self.config.dry_run {
            debug!("Dry run: would follow user: {}", user_id);
            return Ok(true);
        }

        let me = self.me().await?;
        let url = self.url(&format!("/users/{}/following", me.id));
        let headers = self.get_headers("POST", &url);

        let body = serde_json::json!({ "target_user_id": user_id });

        let response = self
            .client
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await?;

        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        Ok(data["data"]["following"].as_bool().unwrap_or(false))
    }

    pub async fn unfollow_user(&mut self, user_id: &str) -> Result<bool> {
        if self.config.dry_run {
            debug!("Dry run: would unfollow user: {}", user_id);
            return Ok(true);
        }

        let me = self.me().await?;
        let url = self.url(&format!("/users/{}/following/{}", me.id, user_id));
        let headers = self.get_headers("DELETE", &url);

        let response = self.client.delete(&url).headers(headers).send().await?;
        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        Ok(!data["data"]["following"].as_bool().unwrap_or(true))
    }

    pub async fn get_followers(
        &self,
        user_id: &str,
        max_results: u32,
        pagination_token: Option<&str>,
    ) -> Result<QueryProfilesResponse> {
        let url = self.url(&format!("/users/{}/followers", user_id));
        let headers = self.get_headers("GET", &url);

        let mut query: Vec<(&str, String)> = vec![
            ("max_results", max_results.min(1000).to_string()),
            (
                "user.fields",
                "id,name,username,description,profile_image_url,verified,public_metrics"
                    .to_string(),
            ),
        ];

        if let Some(token) = pagination_token {
            query.push(("pagination_token", token.to_string()));
        }

        let response = self
            .client
            .get(&url)
            .headers(headers)
            .query(&query)
            .send()
            .await?;
        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        let profiles: Vec<Profile> = data["data"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|u| self.parse_profile(u).ok())
                    .collect()
            })
            .unwrap_or_default();

        Ok(QueryProfilesResponse {
            profiles,
            next_token: data["meta"]["next_token"].as_str().map(String::from),
        })
    }

    pub async fn get_following(
        &self,
        user_id: &str,
        max_results: u32,
        pagination_token: Option<&str>,
    ) -> Result<QueryProfilesResponse> {
        let url = self.url(&format!("/users/{}/following", user_id));
        let headers = self.get_headers("GET", &url);

        let mut query: Vec<(&str, String)> = vec![
            ("max_results", max_results.min(1000).to_string()),
            (
                "user.fields",
                "id,name,username,description,profile_image_url,verified,public_metrics"
                    .to_string(),
            ),
        ];

        if let Some(token) = pagination_token {
            query.push(("pagination_token", token.to_string()));
        }

        let response = self
            .client
            .get(&url)
            .headers(headers)
            .query(&query)
            .send()
            .await?;
        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        let profiles: Vec<Profile> = data["data"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|u| self.parse_profile(u).ok())
                    .collect()
            })
            .unwrap_or_default();

        Ok(QueryProfilesResponse {
            profiles,
            next_token: data["meta"]["next_token"].as_str().map(String::from),
        })
    }

    pub async fn get_home_timeline(
        &mut self,
        max_results: u32,
        pagination_token: Option<&str>,
    ) -> Result<QueryPostsResponse> {
        let me = self.me().await?;
        let url = self.url(&format!("/users/{}/timelines/reverse_chronological", me.id));
        let headers = self.get_headers("GET", &url);

        let mut query: Vec<(&str, String)> = vec![
            ("max_results", max_results.min(100).to_string()),
            ("post.fields", "id,text,created_at,author_id,conversation_id,referenced_posts,entities,public_metrics,attachments".to_string()),
            ("user.fields", "id,name,username,profile_image_url".to_string()),
            ("media.fields", "url,preview_image_url,type".to_string()),
            ("expansions", "author_id,attachments.media_keys,referenced_posts.id".to_string()),
        ];

        if let Some(token) = pagination_token {
            query.push(("pagination_token", token.to_string()));
        }

        let response = self
            .client
            .get(&url)
            .headers(headers)
            .query(&query)
            .send()
            .await?;

        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        let includes = &data["includes"];
        let posts: Vec<Post> = data["data"]
            .as_array()
            .map(|arr| arr.iter().map(|t| self.parse_post(t, includes)).collect())
            .unwrap_or_default();

        Ok(QueryPostsResponse {
            posts,
            next_token: data["meta"]["next_token"].as_str().map(String::from),
        })
    }

    pub async fn get_user_posts(
        &self,
        user_id: &str,
        max_results: u32,
        pagination_token: Option<&str>,
    ) -> Result<QueryPostsResponse> {
        let url = self.url(&format!("/users/{}/posts", user_id));
        let headers = self.get_headers("GET", &url);

        let mut query: Vec<(&str, String)> = vec![
            ("max_results", max_results.min(100).to_string()),
            ("exclude", "reposts,replies".to_string()),
            ("post.fields", "id,text,created_at,author_id,conversation_id,referenced_posts,entities,public_metrics,attachments".to_string()),
            ("user.fields", "id,name,username,profile_image_url".to_string()),
            ("media.fields", "url,preview_image_url,type".to_string()),
            ("expansions", "author_id,attachments.media_keys,referenced_posts.id".to_string()),
        ];

        if let Some(token) = pagination_token {
            query.push(("pagination_token", token.to_string()));
        }

        let response = self
            .client
            .get(&url)
            .headers(headers)
            .query(&query)
            .send()
            .await?;

        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        let includes = &data["includes"];
        let posts: Vec<Post> = data["data"]
            .as_array()
            .map(|arr| arr.iter().map(|t| self.parse_post(t, includes)).collect())
            .unwrap_or_default();

        Ok(QueryPostsResponse {
            posts,
            next_token: data["meta"]["next_token"].as_str().map(String::from),
        })
    }

    pub fn is_authenticated(&self) -> bool {
        !self.config.api_key.is_empty()
            && !self.config.api_secret.is_empty()
            && !self.config.access_token.is_empty()
            && !self.config.access_token_secret.is_empty()
    }

    pub fn username(&self) -> Option<&str> {
        self.me.as_ref().map(|p| p.username.as_str())
    }

    pub async fn search_posts(
        &self,
        query: &str,
        max_results: u32,
        sort_order: Option<&str>,
    ) -> Result<QueryPostsResponse> {
        let url = self.url("/posts/search/recent");
        let headers = self.get_headers("GET", &url);

        let query_params: Vec<(&str, String)> = vec![
            ("query", query.to_string()),
            ("max_results", max_results.min(100).to_string()),
            ("sort_order", sort_order.unwrap_or("relevancy").to_string()),
            ("post.fields", "id,text,created_at,author_id,conversation_id,referenced_posts,entities,public_metrics,attachments".to_string()),
            ("user.fields", "id,name,username,profile_image_url".to_string()),
            ("media.fields", "url,preview_image_url,type".to_string()),
            ("expansions", "author_id,attachments.media_keys,referenced_posts.id".to_string()),
        ];

        let response = self
            .client
            .get(&url)
            .headers(headers)
            .query(&query_params)
            .send()
            .await?;
        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        let includes = &data["includes"];
        let posts: Vec<Post> = data["data"]
            .as_array()
            .map(|arr| arr.iter().map(|t| self.parse_post(t, includes)).collect())
            .unwrap_or_default();

        Ok(QueryPostsResponse {
            posts,
            next_token: data["meta"]["next_token"].as_str().map(String::from),
        })
    }
}
