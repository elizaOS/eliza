//! CharacterFileManager service — manages character snapshots and evolution state.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use super::types::*;

/// Service that manages character snapshots and per-user preferences.
pub struct CharacterFileManager {
    /// User preferences keyed by entity_id.
    preferences: Arc<RwLock<HashMap<Uuid, Vec<UserPreference>>>>,
    /// Character evolution snapshots.
    snapshots: Arc<RwLock<Vec<CharacterSnapshot>>>,
    /// Current character traits.
    traits: Arc<RwLock<Vec<CharacterTrait>>>,
}

impl CharacterFileManager {
    /// Create a new CharacterFileManager.
    pub fn new() -> Self {
        Self {
            preferences: Arc::new(RwLock::new(HashMap::new())),
            snapshots: Arc::new(RwLock::new(Vec::new())),
            traits: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Set a user preference.
    pub async fn set_preference(
        &self,
        entity_id: Uuid,
        key: &str,
        value: &str,
    ) -> anyhow::Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut prefs = self.preferences.write().await;
        let user_prefs = prefs.entry(entity_id).or_insert_with(Vec::new);

        // Update existing or add new
        if let Some(existing) = user_prefs.iter_mut().find(|p| p.key == key) {
            existing.value = value.to_string();
            existing.updated_at = now;
        } else {
            if user_prefs.len() >= MAX_PREFS_PER_USER {
                // Remove oldest
                user_prefs.sort_by_key(|p| p.updated_at);
                user_prefs.remove(0);
            }
            user_prefs.push(UserPreference {
                entity_id,
                key: key.to_string(),
                value: value.to_string(),
                updated_at: now,
            });
        }

        Ok(())
    }

    /// Get all preferences for an entity.
    pub async fn get_preferences(&self, entity_id: Uuid) -> Vec<UserPreference> {
        self.preferences
            .read()
            .await
            .get(&entity_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Take a character snapshot.
    pub async fn take_snapshot(&self, name: &str, reason: &str) -> CharacterSnapshot {
        let traits = self.traits.read().await.clone();
        let snapshot = CharacterSnapshot {
            timestamp: chrono::Utc::now().timestamp_millis(),
            name: name.to_string(),
            traits,
            reason: reason.to_string(),
        };
        self.snapshots.write().await.push(snapshot.clone());
        snapshot
    }

    /// Get all snapshots.
    pub async fn get_snapshots(&self) -> Vec<CharacterSnapshot> {
        self.snapshots.read().await.clone()
    }

    /// Get current character traits.
    pub async fn get_traits(&self) -> Vec<CharacterTrait> {
        self.traits.read().await.clone()
    }

    /// Update a character trait.
    pub async fn update_trait(&self, name: &str, intensity: f64) -> anyhow::Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut traits = self.traits.write().await;

        if let Some(t) = traits.iter_mut().find(|t| t.name == name) {
            t.drift = intensity - t.intensity;
            t.intensity = intensity.clamp(0.0, 1.0);
            t.last_adjusted_at = now;
        } else {
            traits.push(CharacterTrait {
                name: name.to_string(),
                intensity: intensity.clamp(0.0, 1.0),
                drift: 0.0,
                last_adjusted_at: now,
            });
        }

        Ok(())
    }
}

impl Default for CharacterFileManager {
    fn default() -> Self {
        Self::new()
    }
}
