#![allow(missing_docs)]

use crate::config::RobloxConfig;
use crate::error::{Result, RobloxError};
use crate::types::{
    CreatorType, DataStoreEntry, ExperienceCreator, MessagingServiceMessage, RobloxExperienceInfo,
    RobloxUser,
};
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tracing::{debug, info};

const ROBLOX_API_BASE: &str = "https://apis.roblox.com";
const USERS_API_BASE: &str = "https://users.roblox.com";
const GAMES_API_BASE: &str = "https://games.roblox.com";
const THUMBNAILS_API_BASE: &str = "https://thumbnails.roblox.com";

pub struct RobloxClient {
    config: RobloxConfig,
    http: Client,
}

impl RobloxClient {
    pub fn new(config: RobloxConfig) -> Result<Self> {
        config.validate()?;

        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| RobloxError::internal(format!("Failed to create HTTP client: {}", e)))?;

        Ok(Self { config, http })
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        base_url: &str,
        endpoint: &str,
        body: Option<impl Serialize>,
    ) -> Result<T> {
        let url = format!("{}{}", base_url, endpoint);

        let mut request = self
            .http
            .request(method.clone(), &url)
            .header("x-api-key", &self.config.api_key)
            .header("Content-Type", "application/json");

        if let Some(body) = body {
            request = request.json(&body);
        }

        let response = request.send().await?;

        let status = response.status();
        if !status.is_success() {
            let error_body = response.text().await.unwrap_or_default();
            return Err(RobloxError::api(
                format!("API request failed: {}", error_body),
                status.as_u16(),
                endpoint,
            ));
        }

        let text = response.text().await?;
        if text.is_empty() {
            return serde_json::from_str("{}").map_err(Into::into);
        }

        serde_json::from_str(&text).map_err(Into::into)
    }

    pub async fn publish_message(
        &self,
        topic: &str,
        data: impl Serialize,
        universe_id: Option<&str>,
    ) -> Result<()> {
        if self.config.dry_run {
            info!(topic, "DRY RUN: Would publish message");
            return Ok(());
        }

        let target_universe_id = universe_id.unwrap_or(&self.config.universe_id);
        let endpoint = format!(
            "/messaging-service/v1/universes/{}/topics/{}",
            target_universe_id,
            urlencoding::encode(topic)
        );

        let body = serde_json::json!({
            "message": serde_json::to_string(&data)?
        });

        self.request::<serde_json::Value>(
            reqwest::Method::POST,
            ROBLOX_API_BASE,
            &endpoint,
            Some(body),
        )
        .await?;

        debug!(topic, "Published message to topic");
        Ok(())
    }

    pub async fn send_agent_message(&self, message: &MessagingServiceMessage) -> Result<()> {
        self.publish_message(&self.config.messaging_topic, message, None)
            .await
    }

    pub async fn get_datastore_entry<T: DeserializeOwned>(
        &self,
        datastore_name: &str,
        key: &str,
        scope: Option<&str>,
    ) -> Result<Option<DataStoreEntry<T>>> {
        let scope = scope.unwrap_or("global");
        let endpoint = format!(
            "/datastores/v1/universes/{}/standard-datastores/datastore/entries/entry?datastoreName={}&scope={}&entryKey={}",
            self.config.universe_id,
            urlencoding::encode(datastore_name),
            urlencoding::encode(scope),
            urlencoding::encode(key)
        );

        #[derive(Deserialize)]
        struct Response {
            value: String,
            version: String,
            #[serde(rename = "createdTime")]
            created_time: DateTime<Utc>,
            #[serde(rename = "updatedTime")]
            updated_time: DateTime<Utc>,
        }

        match self
            .request::<Response>(reqwest::Method::GET, ROBLOX_API_BASE, &endpoint, None::<()>)
            .await
        {
            Ok(response) => {
                let value: T = serde_json::from_str(&response.value)?;
                Ok(Some(DataStoreEntry {
                    key: key.to_string(),
                    value,
                    version: response.version,
                    created_at: response.created_time,
                    updated_at: response.updated_time,
                }))
            }
            Err(RobloxError::Api {
                status_code: 404, ..
            }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn set_datastore_entry<T: Serialize + Clone>(
        &self,
        datastore_name: &str,
        key: &str,
        value: &T,
        scope: Option<&str>,
    ) -> Result<DataStoreEntry<T>> {
        if self.config.dry_run {
            info!(datastore_name, key, "DRY RUN: Would set DataStore entry");
            return Ok(DataStoreEntry {
                key: key.to_string(),
                value: value.clone(),
                version: "dry-run".to_string(),
                created_at: Utc::now(),
                updated_at: Utc::now(),
            });
        }

        let scope = scope.unwrap_or("global");
        let endpoint = format!(
            "/datastores/v1/universes/{}/standard-datastores/datastore/entries/entry?datastoreName={}&scope={}&entryKey={}",
            self.config.universe_id,
            urlencoding::encode(datastore_name),
            urlencoding::encode(scope),
            urlencoding::encode(key)
        );

        #[derive(Deserialize)]
        struct Response {
            version: String,
            #[serde(rename = "createdTime")]
            created_time: DateTime<Utc>,
            #[serde(rename = "updatedTime")]
            updated_time: DateTime<Utc>,
        }

        let response = self
            .request::<Response>(
                reqwest::Method::POST,
                ROBLOX_API_BASE,
                &endpoint,
                Some(value),
            )
            .await?;

        Ok(DataStoreEntry {
            key: key.to_string(),
            value: value.clone(),
            version: response.version,
            created_at: response.created_time,
            updated_at: response.updated_time,
        })
    }

    pub async fn delete_datastore_entry(
        &self,
        datastore_name: &str,
        key: &str,
        scope: Option<&str>,
    ) -> Result<()> {
        if self.config.dry_run {
            info!(datastore_name, key, "DRY RUN: Would delete DataStore entry");
            return Ok(());
        }

        let scope = scope.unwrap_or("global");
        let endpoint = format!(
            "/datastores/v1/universes/{}/standard-datastores/datastore/entries/entry?datastoreName={}&scope={}&entryKey={}",
            self.config.universe_id,
            urlencoding::encode(datastore_name),
            urlencoding::encode(scope),
            urlencoding::encode(key)
        );

        self.request::<serde_json::Value>(
            reqwest::Method::DELETE,
            ROBLOX_API_BASE,
            &endpoint,
            None::<()>,
        )
        .await?;

        Ok(())
    }

    pub async fn get_user_by_id(&self, user_id: u64) -> Result<RobloxUser> {
        let endpoint = format!("/v1/users/{}", user_id);

        #[derive(Deserialize)]
        struct Response {
            id: u64,
            name: String,
            #[serde(rename = "displayName")]
            display_name: String,
            created: DateTime<Utc>,
            #[serde(rename = "isBanned")]
            is_banned: bool,
        }

        let response = self
            .request::<Response>(reqwest::Method::GET, USERS_API_BASE, &endpoint, None::<()>)
            .await?;

        Ok(RobloxUser {
            id: response.id,
            username: response.name,
            display_name: response.display_name,
            avatar_url: None,
            created_at: Some(response.created),
            is_banned: response.is_banned,
        })
    }

    pub async fn get_user_by_username(&self, username: &str) -> Result<Option<RobloxUser>> {
        let endpoint = "/v1/usernames/users";

        #[derive(Serialize)]
        struct Request {
            usernames: Vec<String>,
            #[serde(rename = "excludeBannedUsers")]
            exclude_banned_users: bool,
        }

        #[derive(Deserialize)]
        struct UserData {
            id: u64,
            name: String,
            #[serde(rename = "displayName")]
            display_name: String,
        }

        #[derive(Deserialize)]
        struct Response {
            data: Vec<UserData>,
        }

        let request = Request {
            usernames: vec![username.to_string()],
            exclude_banned_users: false,
        };

        let response = self
            .request::<Response>(
                reqwest::Method::POST,
                USERS_API_BASE,
                endpoint,
                Some(request),
            )
            .await?;

        Ok(response.data.into_iter().next().map(|user| RobloxUser {
            id: user.id,
            username: user.name,
            display_name: user.display_name,
            avatar_url: None,
            created_at: None,
            is_banned: false,
        }))
    }

    pub async fn get_avatar_url(&self, user_id: u64, size: Option<&str>) -> Result<Option<String>> {
        let size = size.unwrap_or("150x150");
        let endpoint = format!(
            "/v1/users/avatar-headshot?userIds={}&size={}&format=Png",
            user_id, size
        );

        #[derive(Deserialize)]
        struct ImageData {
            #[serde(rename = "imageUrl")]
            image_url: String,
        }

        #[derive(Deserialize)]
        struct Response {
            data: Vec<ImageData>,
        }

        match self
            .request::<Response>(
                reqwest::Method::GET,
                THUMBNAILS_API_BASE,
                &endpoint,
                None::<()>,
            )
            .await
        {
            Ok(response) => Ok(response.data.into_iter().next().map(|d| d.image_url)),
            Err(_) => Ok(None),
        }
    }

    pub async fn get_experience_info(
        &self,
        universe_id: Option<&str>,
    ) -> Result<RobloxExperienceInfo> {
        let target_universe_id = universe_id.unwrap_or(&self.config.universe_id);
        let endpoint = format!("/v1/games?universeIds={}", target_universe_id);

        #[derive(Deserialize)]
        struct GameData {
            name: String,
            description: Option<String>,
            creator: CreatorData,
            playing: Option<u64>,
            visits: Option<u64>,
            #[serde(rename = "rootPlaceId")]
            root_place_id: u64,
        }

        #[derive(Deserialize)]
        struct CreatorData {
            id: u64,
            #[serde(rename = "type")]
            creator_type: String,
            name: String,
        }

        #[derive(Deserialize)]
        struct Response {
            data: Vec<GameData>,
        }

        let response = self
            .request::<Response>(reqwest::Method::GET, GAMES_API_BASE, &endpoint, None::<()>)
            .await?;

        let game = response.data.into_iter().next().ok_or_else(|| {
            RobloxError::not_found(format!("Experience not found: {}", target_universe_id))
        })?;

        Ok(RobloxExperienceInfo {
            universe_id: target_universe_id.to_string(),
            name: game.name,
            description: game.description,
            creator: ExperienceCreator {
                id: game.creator.id,
                creator_type: if game.creator.creator_type == "User" {
                    CreatorType::User
                } else {
                    CreatorType::Group
                },
                name: game.creator.name,
            },
            playing: game.playing,
            visits: game.visits,
            root_place_id: game.root_place_id.to_string(),
        })
    }

    pub fn config(&self) -> &RobloxConfig {
        &self.config
    }

    pub fn is_dry_run(&self) -> bool {
        self.config.dry_run
    }
}
