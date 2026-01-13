#![allow(missing_docs)]

use chrono::Utc;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{debug, info};

use crate::config::{BlueSkyConfig, CHAT_SERVICE_DID};
use crate::error::{BlueSkyError, Result};
use crate::types::*;

pub struct BlueSkyClient {
    config: BlueSkyConfig,
    http: reqwest::Client,
    session: Arc<RwLock<Option<BlueSkySession>>>,
}

impl BlueSkyClient {
    pub fn new(config: BlueSkyConfig) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout()))
            .build()
            .map_err(|e| BlueSkyError::config(format!("HTTP client: {e}")))?;

        Ok(Self {
            config,
            http,
            session: Arc::new(RwLock::new(None)),
        })
    }

    pub fn config(&self) -> &BlueSkyConfig {
        &self.config
    }

    pub async fn session(&self) -> Option<BlueSkySession> {
        self.session.read().await.clone()
    }

    pub async fn authenticate(&self) -> Result<BlueSkySession> {
        debug!(handle = %self.config.handle(), "Authenticating");

        let url = format!(
            "{}/xrpc/com.atproto.server.createSession",
            self.config.service()
        );
        let response = self
            .http
            .post(&url)
            .json(&serde_json::json!({
                "identifier": self.config.handle(),
                "password": self.config.password(),
            }))
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(BlueSkyError::auth(
                response.text().await.unwrap_or_default(),
            ));
        }

        let session: BlueSkySession = response.json().await?;
        info!(handle = %session.handle, "Authenticated");
        *self.session.write().await = Some(session.clone());
        Ok(session)
    }

    pub async fn get_profile(&self, handle: &str) -> Result<BlueSkyProfile> {
        let resp: serde_json::Value = self
            .request(
                "GET",
                "app.bsky.actor.getProfile",
                Some(&[("actor", handle)]),
                None,
                false,
            )
            .await?;
        Ok(BlueSkyProfile {
            did: resp["did"].as_str().unwrap_or("").into(),
            handle: resp["handle"].as_str().unwrap_or("").into(),
            display_name: resp["displayName"].as_str().map(Into::into),
            description: resp["description"].as_str().map(Into::into),
            avatar: resp["avatar"].as_str().map(Into::into),
            followers_count: resp["followersCount"].as_u64(),
            follows_count: resp["followsCount"].as_u64(),
            posts_count: resp["postsCount"].as_u64(),
        })
    }

    pub async fn get_timeline(&self, req: TimelineRequest) -> Result<TimelineResponse> {
        let limit = req.limit.unwrap_or(50).to_string();
        let mut params: Vec<(&str, &str)> = vec![("limit", &limit)];
        if let Some(ref c) = req.cursor {
            params.push(("cursor", c));
        }

        let resp: serde_json::Value = self
            .request(
                "GET",
                "app.bsky.feed.getTimeline",
                Some(&params),
                None,
                false,
            )
            .await?;
        let feed = resp["feed"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        self.map_post(&item["post"])
                            .ok()
                            .map(|post| TimelineFeedItem {
                                post,
                                reply: item.get("reply").cloned(),
                            })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(TimelineResponse {
            cursor: resp["cursor"].as_str().map(Into::into),
            feed,
        })
    }

    pub async fn send_post(&self, req: CreatePostRequest) -> Result<BlueSkyPost> {
        if self.config.dry_run() {
            info!(text = %req.text, "Dry run: would post");
            return Ok(self.mock_post(&req.text).await);
        }

        let session = self.session.read().await;
        let session = session
            .as_ref()
            .ok_or_else(|| BlueSkyError::auth("Not authenticated"))?;

        let mut record = serde_json::json!({
            "$type": "app.bsky.feed.post",
            "text": req.text,
            "createdAt": Utc::now().to_rfc3339(),
        });

        if let Some(ref r) = req.reply_to {
            record["reply"] = serde_json::json!({
                "root": { "uri": r.uri, "cid": r.cid },
                "parent": { "uri": r.uri, "cid": r.cid },
            });
        }

        let resp: serde_json::Value = self
            .request(
                "POST",
                "com.atproto.repo.createRecord",
                None,
                Some(serde_json::json!({
                    "repo": session.did,
                    "collection": "app.bsky.feed.post",
                    "record": record,
                })),
                false,
            )
            .await?;

        let uri = resp["uri"]
            .as_str()
            .ok_or_else(|| BlueSkyError::post("No URI", "create"))?;
        let thread: serde_json::Value = self
            .request(
                "GET",
                "app.bsky.feed.getPostThread",
                Some(&[("uri", uri), ("depth", "0")]),
                None,
                false,
            )
            .await?;

        if thread["thread"]["$type"] == "app.bsky.feed.defs#threadViewPost" {
            return self.map_post(&thread["thread"]["post"]);
        }
        Err(BlueSkyError::post("Failed to get post", "create"))
    }

    pub async fn delete_post(&self, uri: &str) -> Result<()> {
        if self.config.dry_run() {
            info!(uri, "Dry run: would delete");
            return Ok(());
        }

        let session = self.session.read().await;
        let session = session
            .as_ref()
            .ok_or_else(|| BlueSkyError::auth("Not authenticated"))?;
        let rkey = uri
            .split('/')
            .next_back()
            .ok_or_else(|| BlueSkyError::post("Invalid URI", "delete"))?;

        self.request(
            "POST",
            "com.atproto.repo.deleteRecord",
            None,
            Some(serde_json::json!({
                "repo": session.did,
                "collection": "app.bsky.feed.post",
                "rkey": rkey,
            })),
            false,
        )
        .await?;
        Ok(())
    }

    pub async fn like_post(&self, uri: &str, cid: &str) -> Result<()> {
        if self.config.dry_run() {
            return Ok(());
        }
        let session = self.session.read().await;
        let session = session
            .as_ref()
            .ok_or_else(|| BlueSkyError::auth("Not authenticated"))?;

        self.request(
            "POST",
            "com.atproto.repo.createRecord",
            None,
            Some(serde_json::json!({
                "repo": session.did,
                "collection": "app.bsky.feed.like",
                "record": {
                    "$type": "app.bsky.feed.like",
                    "subject": { "uri": uri, "cid": cid },
                    "createdAt": Utc::now().to_rfc3339(),
                },
            })),
            false,
        )
        .await?;
        Ok(())
    }

    pub async fn repost(&self, uri: &str, cid: &str) -> Result<()> {
        if self.config.dry_run() {
            return Ok(());
        }
        let session = self.session.read().await;
        let session = session
            .as_ref()
            .ok_or_else(|| BlueSkyError::auth("Not authenticated"))?;

        self.request(
            "POST",
            "com.atproto.repo.createRecord",
            None,
            Some(serde_json::json!({
                "repo": session.did,
                "collection": "app.bsky.feed.repost",
                "record": {
                    "$type": "app.bsky.feed.repost",
                    "subject": { "uri": uri, "cid": cid },
                    "createdAt": Utc::now().to_rfc3339(),
                },
            })),
            false,
        )
        .await?;
        Ok(())
    }

    pub async fn get_notifications(
        &self,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<(Vec<BlueSkyNotification>, Option<String>)> {
        let limit_s = limit.to_string();
        let mut params: Vec<(&str, &str)> = vec![("limit", &limit_s)];
        if let Some(c) = cursor {
            params.push(("cursor", c));
        }

        let resp: serde_json::Value = self
            .request(
                "GET",
                "app.bsky.notification.listNotifications",
                Some(&params),
                None,
                false,
            )
            .await?;
        let notifs = resp["notifications"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|n| {
                        let reason = match n["reason"].as_str()? {
                            "mention" => NotificationReason::Mention,
                            "reply" => NotificationReason::Reply,
                            "follow" => NotificationReason::Follow,
                            "like" => NotificationReason::Like,
                            "repost" => NotificationReason::Repost,
                            "quote" => NotificationReason::Quote,
                            _ => return None,
                        };
                        Some(BlueSkyNotification {
                            uri: n["uri"].as_str()?.into(),
                            cid: n["cid"].as_str()?.into(),
                            author: BlueSkyProfile::new(
                                n["author"]["did"].as_str().unwrap_or(""),
                                n["author"]["handle"].as_str().unwrap_or(""),
                            ),
                            reason,
                            reason_subject: n["reasonSubject"].as_str().map(Into::into),
                            record: n["record"].clone(),
                            is_read: n["isRead"].as_bool().unwrap_or(false),
                            indexed_at: n["indexedAt"].as_str()?.into(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok((notifs, resp["cursor"].as_str().map(Into::into)))
    }

    pub async fn update_seen_notifications(&self) -> Result<()> {
        self.request(
            "POST",
            "app.bsky.notification.updateSeen",
            None,
            Some(serde_json::json!({ "seenAt": Utc::now().to_rfc3339() })),
            false,
        )
        .await?;
        Ok(())
    }

    pub async fn get_conversations(
        &self,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<(Vec<BlueSkyConversation>, Option<String>)> {
        let limit_s = limit.to_string();
        let mut params: Vec<(&str, &str)> = vec![("limit", &limit_s)];
        if let Some(c) = cursor {
            params.push(("cursor", c));
        }

        let resp: serde_json::Value = self
            .request(
                "GET",
                "chat.bsky.convo.listConvos",
                Some(&params),
                None,
                true,
            )
            .await?;
        let convos = resp["convos"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|c| {
                        Some(BlueSkyConversation {
                            id: c["id"].as_str()?.into(),
                            rev: c["rev"].as_str()?.into(),
                            unread_count: c["unreadCount"].as_u64().unwrap_or(0) as u32,
                            muted: c["muted"].as_bool().unwrap_or(false),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok((convos, resp["cursor"].as_str().map(Into::into)))
    }

    pub async fn get_messages(
        &self,
        convo_id: &str,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<(Vec<BlueSkyMessage>, Option<String>)> {
        let limit_s = limit.to_string();
        let mut params: Vec<(&str, &str)> = vec![("convoId", convo_id), ("limit", &limit_s)];
        if let Some(c) = cursor {
            params.push(("cursor", c));
        }

        let resp: serde_json::Value = self
            .request(
                "GET",
                "chat.bsky.convo.getMessages",
                Some(&params),
                None,
                true,
            )
            .await?;
        let msgs = resp["messages"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        Some(BlueSkyMessage {
                            id: m["id"].as_str()?.into(),
                            rev: m["rev"].as_str()?.into(),
                            text: m["text"].as_str().map(Into::into),
                            sender: MessageSender {
                                did: m["sender"]["did"].as_str()?.into(),
                            },
                            sent_at: m["sentAt"].as_str()?.into(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok((msgs, resp["cursor"].as_str().map(Into::into)))
    }

    pub async fn send_message(&self, req: SendMessageRequest) -> Result<BlueSkyMessage> {
        if self.config.dry_run() {
            info!(convo = %req.convo_id, "Dry run: would message");
            return Ok(self.mock_message(&req.text));
        }

        let resp: serde_json::Value = self
            .request(
                "POST",
                "chat.bsky.convo.sendMessage",
                None,
                Some(serde_json::json!({
                    "convoId": req.convo_id,
                    "message": { "text": req.text },
                })),
                true,
            )
            .await?;

        Ok(BlueSkyMessage {
            id: resp["id"].as_str().unwrap_or("").into(),
            rev: resp["rev"].as_str().unwrap_or("").into(),
            text: resp["text"].as_str().map(Into::into),
            sender: MessageSender {
                did: resp["sender"]["did"].as_str().unwrap_or("").into(),
            },
            sent_at: resp["sentAt"].as_str().unwrap_or("").into(),
        })
    }

    pub async fn close(&self) {
        *self.session.write().await = None;
    }

    async fn request(
        &self,
        method: &str,
        endpoint: &str,
        params: Option<&[(&str, &str)]>,
        json: Option<serde_json::Value>,
        chat: bool,
    ) -> Result<serde_json::Value> {
        let session = self.session.read().await;
        let session = session
            .as_ref()
            .ok_or_else(|| BlueSkyError::auth("Not authenticated"))?;

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", session.access_jwt)).unwrap(),
        );
        if chat {
            headers.insert("atproto-proxy", HeaderValue::from_static(CHAT_SERVICE_DID));
        }

        let url = format!("{}/xrpc/{}", self.config.service(), endpoint);
        let req = if method == "GET" {
            let mut b = self.http.get(&url);
            if let Some(p) = params {
                b = b.query(p);
            }
            b
        } else {
            let mut b = self.http.post(&url);
            if let Some(j) = json {
                b = b.json(&j);
            }
            b
        };

        let resp = req.headers(headers).send().await?;
        let status = resp.status().as_u16();

        if status == 429 {
            return Err(BlueSkyError::RateLimit(60));
        }
        if !resp.status().is_success() {
            return Err(BlueSkyError::http(
                resp.text().await.unwrap_or_default(),
                status,
            ));
        }

        Ok(resp.json().await?)
    }

    fn map_post(&self, data: &serde_json::Value) -> Result<BlueSkyPost> {
        let record = &data["record"];
        Ok(BlueSkyPost {
            uri: data["uri"]
                .as_str()
                .ok_or_else(|| BlueSkyError::post("No URI", "map"))?
                .into(),
            cid: data["cid"]
                .as_str()
                .ok_or_else(|| BlueSkyError::post("No CID", "map"))?
                .into(),
            author: BlueSkyProfile::new(
                data["author"]["did"].as_str().unwrap_or(""),
                data["author"]["handle"].as_str().unwrap_or(""),
            ),
            record: PostRecord {
                record_type: record["$type"]
                    .as_str()
                    .unwrap_or("app.bsky.feed.post")
                    .into(),
                text: record["text"].as_str().unwrap_or("").into(),
                created_at: record["createdAt"].as_str().unwrap_or("").into(),
            },
            reply_count: data["replyCount"].as_u64(),
            repost_count: data["repostCount"].as_u64(),
            like_count: data["likeCount"].as_u64(),
            indexed_at: data["indexedAt"].as_str().unwrap_or("").into(),
        })
    }

    async fn mock_post(&self, text: &str) -> BlueSkyPost {
        let session = self.session.read().await;
        let now = Utc::now().to_rfc3339();
        BlueSkyPost {
            uri: format!("mock://post/{now}"),
            cid: format!("mock-cid-{now}"),
            author: BlueSkyProfile::new(
                session
                    .as_ref()
                    .map(|s| s.did.as_str())
                    .unwrap_or("did:plc:mock"),
                session
                    .as_ref()
                    .map(|s| s.handle.as_str())
                    .unwrap_or("mock.handle"),
            ),
            record: PostRecord {
                record_type: "app.bsky.feed.post".into(),
                text: text.into(),
                created_at: now.clone(),
            },
            reply_count: None,
            repost_count: None,
            like_count: None,
            indexed_at: now,
        }
    }

    fn mock_message(&self, text: &str) -> BlueSkyMessage {
        BlueSkyMessage {
            id: format!("mock-msg-{}", Utc::now().timestamp()),
            rev: "1".into(),
            text: Some(text.into()),
            sender: MessageSender {
                did: "did:plc:mock".into(),
            },
            sent_at: Utc::now().to_rfc3339(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_creation() {
        let cfg = BlueSkyConfig::new("test.bsky.social", "password").unwrap();
        assert!(BlueSkyClient::new(cfg).is_ok());
    }
}
