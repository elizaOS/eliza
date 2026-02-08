//! Rolodex service implementation.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;

use super::{Service, ServiceType};

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
pub struct RolodexService {
    contacts: HashMap<Uuid, ContactInfo>,
    analytics: HashMap<Uuid, RelationshipAnalytics>,
    runtime: Option<Arc<dyn IAgentRuntime>>,
}

impl RolodexService {
    /// Create a new rolodex service.
    pub fn new() -> Self {
        Self {
            contacts: HashMap::new(),
            analytics: HashMap::new(),
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
            runtime.log_info("service:rolodex", &format!("Added contact: {}", entity_id));
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
}

impl Default for RolodexService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Service for RolodexService {
    fn name(&self) -> &'static str {
        "rolodex"
    }

    fn service_type(&self) -> ServiceType {
        ServiceType::Core
    }

    async fn start(&mut self, runtime: Arc<dyn IAgentRuntime>) -> PluginResult<()> {
        runtime.log_info("service:rolodex", "Rolodex service started");
        self.runtime = Some(runtime);
        Ok(())
    }

    async fn stop(&mut self) -> PluginResult<()> {
        if let Some(runtime) = &self.runtime {
            runtime.log_info("service:rolodex", "Rolodex service stopped");
        }
        self.contacts.clear();
        self.analytics.clear();
        self.runtime = None;
        Ok(())
    }
}
