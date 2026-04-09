//! Relationships service implementation.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;

use super::{Service, ServiceType};

/// A named contact category (e.g., "friend", "family", "vip").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactCategory {
    pub id: String,
    pub name: String,
    pub description: String,
    pub color: String,
}

/// Categorized relationship insights for an entity.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RelationshipInsights {
    /// Top relationships sorted by strength (up to 10).
    pub strongest_relationships: Vec<RelationshipInsightEntry>,
    /// Contacts with no interaction in 30+ days.
    pub needs_attention: Vec<NeedsAttentionEntry>,
    /// Most recent interactions (up to 10, newest first).
    pub recent_interactions: Vec<RecentInteractionEntry>,
}

/// A single entry in the "strongest relationships" list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelationshipInsightEntry {
    pub entity_id: Uuid,
    pub analytics: RelationshipAnalytics,
}

/// A contact that has not been interacted with recently.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NeedsAttentionEntry {
    pub entity_id: Uuid,
    pub days_since_contact: i64,
}

/// A recently-interacted contact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentInteractionEntry {
    pub entity_id: Uuid,
    pub last_interaction: DateTime<Utc>,
}

/// Contact preferences.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContactPreferences {
    pub preferred_channel: Option<String>,
    pub timezone: Option<String>,
    pub language: Option<String>,
    pub contact_frequency: Option<String>,
    pub do_not_disturb: bool,
    pub notes: Option<String>,
}

/// Contact information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactInfo {
    pub entity_id: Uuid,
    pub categories: Vec<String>,
    pub tags: Vec<String>,
    pub preferences: ContactPreferences,
    pub custom_fields: HashMap<String, serde_json::Value>,
    pub privacy_level: String,
    pub last_modified: DateTime<Utc>,
}

/// Relationship analytics.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RelationshipAnalytics {
    pub strength: f64,
    pub interaction_count: u32,
    pub last_interaction_at: Option<DateTime<Utc>>,
    pub average_response_time: Option<f64>,
    pub sentiment_score: Option<f64>,
    pub topics_discussed: Vec<String>,
}

/// Calculate relationship strength based on interaction patterns.
pub fn calculate_relationship_strength(
    interaction_count: u32,
    last_interaction_at: Option<DateTime<Utc>>,
    message_quality: f64,
    relationship_type: &str,
) -> f64 {
    // Base score from interaction count (max 40 points)
    let interaction_score = (interaction_count as f64 * 2.0).min(40.0);

    // Recency score (max 30 points)
    let recency_score = if let Some(last) = last_interaction_at {
        let days_since = (Utc::now() - last).num_days();
        if days_since < 1 {
            30.0
        } else if days_since < 7 {
            25.0
        } else if days_since < 30 {
            15.0
        } else if days_since < 90 {
            5.0
        } else {
            0.0
        }
    } else {
        0.0
    };

    // Quality score (max 20 points)
    let quality_score = (message_quality * 2.0).min(20.0);

    // Relationship type bonus (max 10 points)
    let relationship_bonus = match relationship_type {
        "family" => 10.0,
        "friend" => 8.0,
        "colleague" => 6.0,
        "acquaintance" => 4.0,
        _ => 0.0,
    };

    let total = interaction_score + recency_score + quality_score + relationship_bonus;
    total.max(0.0).min(100.0)
}

/// Service for managing contacts and relationships.
pub struct RelationshipsService {
    contacts: HashMap<Uuid, ContactInfo>,
    analytics: HashMap<Uuid, RelationshipAnalytics>,
    categories: Vec<ContactCategory>,
    runtime: Option<Arc<dyn IAgentRuntime>>,
}

impl RelationshipsService {
    /// Create a new relationships service.
    pub fn new() -> Self {
        Self {
            contacts: HashMap::new(),
            analytics: HashMap::new(),
            categories: default_categories(),
            runtime: None,
        }
    }

    /// Add a new contact.
    pub fn add_contact(
        &mut self,
        entity_id: Uuid,
        categories: Vec<String>,
        preferences: Option<ContactPreferences>,
    ) -> ContactInfo {
        let contact = ContactInfo {
            entity_id,
            categories: if categories.is_empty() {
                vec!["acquaintance".to_string()]
            } else {
                categories
            },
            tags: Vec::new(),
            preferences: preferences.unwrap_or_default(),
            custom_fields: HashMap::new(),
            privacy_level: "private".to_string(),
            last_modified: Utc::now(),
        };

        if let Some(runtime) = &self.runtime {
            runtime.log_info(
                "service:relationships",
                &format!("Added contact: {}", entity_id),
            );
        }

        self.contacts.insert(entity_id, contact.clone());
        contact
    }

    /// Get a contact by entity ID.
    pub fn get_contact(&self, entity_id: Uuid) -> Option<&ContactInfo> {
        self.contacts.get(&entity_id)
    }

    /// Update a contact.
    pub fn update_contact(
        &mut self,
        entity_id: Uuid,
        categories: Option<Vec<String>>,
        tags: Option<Vec<String>>,
    ) -> Option<&ContactInfo> {
        if let Some(contact) = self.contacts.get_mut(&entity_id) {
            if let Some(cats) = categories {
                contact.categories = cats;
            }
            if let Some(t) = tags {
                contact.tags = t;
            }
            contact.last_modified = Utc::now();
            Some(contact)
        } else {
            None
        }
    }

    /// Remove a contact.
    pub fn remove_contact(&mut self, entity_id: Uuid) -> bool {
        self.contacts.remove(&entity_id).is_some()
    }

    /// Search contacts by criteria.
    pub fn search_contacts(
        &self,
        categories: Option<&[String]>,
        tags: Option<&[String]>,
    ) -> Vec<&ContactInfo> {
        self.contacts
            .values()
            .filter(|c| {
                let cat_match = categories
                    .map(|cats| cats.iter().any(|cat| c.categories.contains(cat)))
                    .unwrap_or(true);
                let tag_match = tags
                    .map(|ts| ts.iter().any(|t| c.tags.contains(t)))
                    .unwrap_or(true);
                cat_match && tag_match
            })
            .collect()
    }

    /// Get all contacts.
    pub fn get_all_contacts(&self) -> Vec<&ContactInfo> {
        self.contacts.values().collect()
    }

    /// Get relationship analytics.
    pub fn get_analytics(&self, entity_id: Uuid) -> Option<&RelationshipAnalytics> {
        self.analytics.get(&entity_id)
    }

    /// Update relationship analytics.
    pub fn update_analytics(
        &mut self,
        entity_id: Uuid,
        interaction_count: Option<u32>,
        last_interaction_at: Option<DateTime<Utc>>,
    ) -> &RelationshipAnalytics {
        let analytics = self.analytics.entry(entity_id).or_default();

        if let Some(count) = interaction_count {
            analytics.interaction_count = count;
        }
        if let Some(last) = last_interaction_at {
            analytics.last_interaction_at = Some(last);
        }

        // Recalculate strength
        let relationship_type = self
            .contacts
            .get(&entity_id)
            .and_then(|c| c.categories.first())
            .map(|s| s.as_str())
            .unwrap_or("acquaintance");

        analytics.strength = calculate_relationship_strength(
            analytics.interaction_count,
            analytics.last_interaction_at,
            5.0,
            relationship_type,
        );

        analytics
    }

    /// Analyze the relationship between two entities, returning computed
    /// analytics (strength, interaction count, sentiment, topics).
    ///
    /// Returns `None` if neither entity has analytics recorded.
    pub fn analyze_relationship(
        &self,
        source_entity_id: &Uuid,
        target_entity_id: &Uuid,
    ) -> Option<RelationshipAnalytics> {
        // Check the composite key first, then fall back to per-entity analytics.
        let composite_key = composite_analytics_key(source_entity_id, target_entity_id);
        if let Some(a) = self.analytics.get(&composite_key) {
            return Some(a.clone());
        }

        // Fall back: merge data from both sides.
        let source = self.analytics.get(source_entity_id);
        let target = self.analytics.get(target_entity_id);

        match (source, target) {
            (Some(s), Some(t)) => {
                let interaction_count = s.interaction_count + t.interaction_count;
                let last_interaction_at = match (s.last_interaction_at, t.last_interaction_at) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (a @ Some(_), None) | (None, a @ Some(_)) => a,
                    (None, None) => None,
                };
                let sentiment_score = match (s.sentiment_score, t.sentiment_score) {
                    (Some(a), Some(b)) => Some((a + b) / 2.0),
                    (a, b) => a.or(b),
                };
                let mut topics: Vec<String> = s.topics_discussed.clone();
                for topic in &t.topics_discussed {
                    if !topics.contains(topic) {
                        topics.push(topic.clone());
                    }
                }
                let relationship_type = self
                    .contacts
                    .get(source_entity_id)
                    .or_else(|| self.contacts.get(target_entity_id))
                    .and_then(|c| c.categories.first())
                    .map(|s| s.as_str())
                    .unwrap_or("acquaintance");
                let strength = calculate_relationship_strength(
                    interaction_count,
                    last_interaction_at,
                    5.0,
                    relationship_type,
                );
                Some(RelationshipAnalytics {
                    strength,
                    interaction_count,
                    last_interaction_at,
                    average_response_time: s.average_response_time.or(t.average_response_time),
                    sentiment_score,
                    topics_discussed: topics,
                })
            }
            (Some(a), None) | (None, Some(a)) => Some(a.clone()),
            (None, None) => None,
        }
    }

    /// Return categorized relationship insights for an entity.
    ///
    /// * **strongest_relationships** -- top 10 contacts by strength score.
    /// * **needs_attention** -- contacts with no interaction in 30+ days.
    /// * **recent_interactions** -- last 10 contacts by interaction time.
    pub fn get_relationship_insights(&self, entity_id: &Uuid) -> RelationshipInsights {
        let now = Utc::now();

        // Collect analytics for every *other* entity that shares analytics with `entity_id`.
        let mut entries: Vec<(Uuid, RelationshipAnalytics)> = Vec::new();
        for (other_id, analytics) in &self.analytics {
            if other_id == entity_id {
                continue;
            }
            entries.push((*other_id, analytics.clone()));
        }

        // Strongest (top 10 by strength, descending).
        let mut by_strength = entries.clone();
        by_strength.sort_by(|a, b| {
            b.1.strength
                .partial_cmp(&a.1.strength)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let strongest_relationships: Vec<RelationshipInsightEntry> = by_strength
            .iter()
            .take(10)
            .map(|(id, a)| RelationshipInsightEntry {
                entity_id: id.clone(),
                analytics: a.clone(),
            })
            .collect();

        // Needs attention (no interaction in 30+ days).
        let needs_attention: Vec<NeedsAttentionEntry> = entries
            .iter()
            .filter_map(|(id, a)| {
                a.last_interaction_at.and_then(|last| {
                    let days = (now - last).num_days();
                    if days >= 30 {
                        Some(NeedsAttentionEntry {
                            entity_id: id.clone(),
                            days_since_contact: days,
                        })
                    } else {
                        None
                    }
                })
            })
            .collect();

        // Recent interactions (last 10, newest first).
        let mut with_interaction: Vec<(Uuid, DateTime<Utc>)> = entries
            .iter()
            .filter_map(|(id, a)| a.last_interaction_at.map(|ts| (id.clone(), ts)))
            .collect();
        with_interaction.sort_by(|a, b| b.1.cmp(&a.1));
        let recent_interactions: Vec<RecentInteractionEntry> = with_interaction
            .into_iter()
            .take(10)
            .map(|(id, ts)| RecentInteractionEntry {
                entity_id: id,
                last_interaction: ts,
            })
            .collect();

        RelationshipInsights {
            strongest_relationships,
            needs_attention,
            recent_interactions,
        }
    }

    /// Return all contact categories.
    pub fn get_categories(&self) -> &[ContactCategory] {
        &self.categories
    }

    /// Add a new contact category. Does nothing if a category with the same
    /// `id` already exists.
    pub fn add_category(&mut self, category: ContactCategory) {
        if self.categories.iter().any(|c| c.id == category.id) {
            return;
        }
        if let Some(runtime) = &self.runtime {
            runtime.log_info(
                "service:relationships",
                &format!("Added category: {}", category.name),
            );
        }
        self.categories.push(category);
    }

    /// Set the privacy level on a contact. Returns `false` if the contact does
    /// not exist.
    pub fn set_contact_privacy(&mut self, entity_id: &Uuid, privacy_level: &str) -> bool {
        let valid = matches!(privacy_level, "public" | "private" | "restricted");
        if !valid {
            return false;
        }
        if let Some(contact) = self.contacts.get_mut(entity_id) {
            contact.privacy_level = privacy_level.to_string();
            contact.last_modified = Utc::now();
            if let Some(runtime) = &self.runtime {
                runtime.log_info(
                    "service:relationships",
                    &format!("Set privacy for {} to {}", entity_id, privacy_level),
                );
            }
            true
        } else {
            false
        }
    }

    /// Check whether `requesting_entity_id` can access the contact record of
    /// `target_entity_id`. The owning agent always has access.
    pub fn can_access_contact(&self, requesting_entity_id: &Uuid, target_entity_id: &Uuid) -> bool {
        let contact = match self.contacts.get(target_entity_id) {
            Some(c) => c,
            None => return false,
        };
        match contact.privacy_level.as_str() {
            "public" => true,
            "private" => requesting_entity_id == target_entity_id,
            "restricted" => false,
            _ => false,
        }
    }
}

/// Build a deterministic composite key for a pair of entity IDs so that
/// `(a, b)` and `(b, a)` map to the same analytics entry.
fn composite_analytics_key(a: &Uuid, b: &Uuid) -> Uuid {
    use std::hash::{Hash, Hasher};
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    lo.hash(&mut hasher);
    hi.hash(&mut hasher);
    let hash = hasher.finish();
    // Construct a v4-shaped UUID from the hash (not cryptographic, just a key).
    let bytes = hash.to_le_bytes();
    let mut buf = [0u8; 16];
    buf[..8].copy_from_slice(&bytes);
    buf[8..16].copy_from_slice(&bytes);
    Uuid::from_bytes(buf)
}

/// Default contact categories matching the TypeScript service.
fn default_categories() -> Vec<ContactCategory> {
    vec![
        ContactCategory {
            id: "friend".into(),
            name: "Friend".into(),
            description: String::new(),
            color: "#4CAF50".into(),
        },
        ContactCategory {
            id: "family".into(),
            name: "Family".into(),
            description: String::new(),
            color: "#2196F3".into(),
        },
        ContactCategory {
            id: "colleague".into(),
            name: "Colleague".into(),
            description: String::new(),
            color: "#FF9800".into(),
        },
        ContactCategory {
            id: "acquaintance".into(),
            name: "Acquaintance".into(),
            description: String::new(),
            color: "#9E9E9E".into(),
        },
        ContactCategory {
            id: "vip".into(),
            name: "VIP".into(),
            description: String::new(),
            color: "#9C27B0".into(),
        },
        ContactCategory {
            id: "business".into(),
            name: "Business".into(),
            description: String::new(),
            color: "#795548".into(),
        },
    ]
}

impl Default for RelationshipsService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Service for RelationshipsService {
    fn name(&self) -> &'static str {
        "relationships"
    }

    fn service_type(&self) -> ServiceType {
        ServiceType::Core
    }

    async fn start(&mut self, runtime: Arc<dyn IAgentRuntime>) -> PluginResult<()> {
        runtime.log_info("service:relationships", "Relationships service started");
        self.runtime = Some(runtime);
        Ok(())
    }

    async fn stop(&mut self) -> PluginResult<()> {
        if let Some(runtime) = &self.runtime {
            runtime.log_info("service:relationships", "Relationships service stopped");
        }
        self.contacts.clear();
        self.analytics.clear();
        self.categories.clear();
        self.runtime = None;
        Ok(())
    }
}
