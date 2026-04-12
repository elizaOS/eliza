//! Native runtime features for knowledge, relationships, and trajectories.
#![allow(missing_docs)]

use crate::runtime::{AgentRuntime, Service as RuntimeService, TrajectoryLogs};
use crate::types::components::{
    ActionDefinition, ActionHandler, ActionResult, EvaluatorDefinition, EvaluatorHandler,
    HandlerOptions, ProviderDefinition, ProviderHandler, ProviderResult,
};
use crate::types::database::SearchMemoriesParams;
use crate::types::plugin::Plugin;
use crate::types::primitives::UUID;
use crate::types::{Memory, State};
use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use std::any::Any;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

/// Canonical native runtime feature names.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum NativeRuntimeFeature {
    /// Native knowledge retrieval provider.
    Knowledge,
    /// Native contact, relationship, and follow-up capabilities.
    Relationships,
    /// Native trajectory tracing service.
    Trajectories,
}

impl NativeRuntimeFeature {
    /// Return the canonical feature slug.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Knowledge => "knowledge",
            Self::Relationships => "relationships",
            Self::Trajectories => "trajectories",
        }
    }
}

/// Default enablement for native runtime features.
pub const NATIVE_RUNTIME_FEATURE_DEFAULTS: [(NativeRuntimeFeature, bool); 3] = [
    (NativeRuntimeFeature::Knowledge, true),
    (NativeRuntimeFeature::Relationships, true),
    (NativeRuntimeFeature::Trajectories, true),
];

/// Resolve a canonical or legacy plugin name to a native feature.
pub fn resolve_native_runtime_feature_from_plugin_name(
    plugin_name: &str,
) -> Option<NativeRuntimeFeature> {
    match plugin_name {
        "knowledge" => Some(NativeRuntimeFeature::Knowledge),
        "relationships" => Some(NativeRuntimeFeature::Relationships),
        "trajectories" => Some(NativeRuntimeFeature::Trajectories),
        _ => None,
    }
}

#[derive(Clone, Debug)]
pub struct ContactPreferences {
    pub preferred_channel: Option<String>,
    pub timezone: Option<String>,
    pub language: Option<String>,
    pub contact_frequency: Option<String>,
    pub do_not_disturb: bool,
    pub notes: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ContactInfo {
    pub entity_id: UUID,
    pub categories: Vec<String>,
    pub tags: Vec<String>,
    pub preferences: ContactPreferences,
    pub custom_fields: HashMap<String, Value>,
    pub privacy_level: String,
    pub last_modified: String,
}

#[derive(Clone, Debug, Default)]
pub struct RelationshipAnalytics {
    pub strength: f64,
    pub interaction_count: u32,
    pub last_interaction_at: Option<String>,
    pub average_response_time: Option<f64>,
    pub sentiment_score: Option<f64>,
    pub topics_discussed: Vec<String>,
}

/// A named contact category (e.g., "friend", "family", "vip").
#[derive(Clone, Debug)]
pub struct ContactCategory {
    pub id: String,
    pub name: String,
    pub description: String,
    pub color: String,
}

/// Categorized relationship insights for an entity.
#[derive(Clone, Debug, Default)]
pub struct RelationshipInsights {
    /// Top relationships sorted by strength (up to 10).
    pub strongest_relationships: Vec<RelationshipInsightEntry>,
    /// Contacts with no interaction in 30+ days.
    pub needs_attention: Vec<NeedsAttentionEntry>,
    /// Most recent interactions (up to 10, newest first).
    pub recent_interactions: Vec<RecentInteractionEntry>,
}

/// A single entry in the "strongest relationships" list.
#[derive(Clone, Debug)]
pub struct RelationshipInsightEntry {
    pub entity_id: UUID,
    pub analytics: RelationshipAnalytics,
}

/// A contact that has not been interacted with recently.
#[derive(Clone, Debug)]
pub struct NeedsAttentionEntry {
    pub entity_id: UUID,
    pub days_since_contact: i64,
}

/// A recently-interacted contact.
#[derive(Clone, Debug)]
pub struct RecentInteractionEntry {
    pub entity_id: UUID,
    pub last_interaction: String,
}

#[derive(Clone, Debug)]
pub struct FollowUpTask {
    pub entity_id: UUID,
    pub reason: String,
    pub message: Option<String>,
    pub priority: String,
    pub scheduled_at: String,
    pub metadata: HashMap<String, Value>,
}

fn calculate_relationship_strength(
    interaction_count: u32,
    last_interaction_at: Option<&str>,
    relationship_type: &str,
) -> f64 {
    let interaction_score = f64::from((interaction_count * 2).min(40));
    let recency_score = last_interaction_at
        .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
        .map(|last_seen| {
            let days_since = (Utc::now() - last_seen.with_timezone(&Utc)).num_days();
            match days_since {
                i64::MIN..=0 => 30.0,
                1..=6 => 25.0,
                7..=29 => 15.0,
                30..=89 => 5.0,
                _ => 0.0,
            }
        })
        .unwrap_or(0.0);

    let relationship_bonus = match relationship_type {
        "family" => 10.0,
        "friend" => 8.0,
        "colleague" => 6.0,
        "vip" => 9.0,
        _ => 4.0,
    };

    (interaction_score + recency_score + relationship_bonus)
        .clamp(0.0, 100.0)
        .round()
}

fn extract_categories(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut categories = Vec::new();
    for (needle, category) in [
        ("friend", "friend"),
        ("family", "family"),
        ("colleague", "colleague"),
        ("coworker", "colleague"),
        ("business", "business"),
        ("vip", "vip"),
    ] {
        if lower.contains(needle) && !categories.iter().any(|existing| existing == category) {
            categories.push(category.to_string());
        }
    }
    if categories.is_empty() {
        categories.push("acquaintance".to_string());
    }
    categories
}

fn extract_explicit_categories(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut categories = Vec::new();
    for (needle, category) in [
        ("friend", "friend"),
        ("family", "family"),
        ("colleague", "colleague"),
        ("coworker", "colleague"),
        ("business", "business"),
        ("vip", "vip"),
        ("acquaintance", "acquaintance"),
    ] {
        if lower.contains(needle) && !categories.iter().any(|existing| existing == category) {
            categories.push(category.to_string());
        }
    }
    categories
}

fn extract_tags(text: &str) -> Vec<String> {
    text.split_whitespace()
        .filter_map(|word| word.strip_prefix('#'))
        .map(|tag| {
            tag.trim_matches(|ch: char| !ch.is_alphanumeric() && ch != '-' && ch != '_')
                .to_lowercase()
        })
        .filter(|tag| !tag.is_empty())
        .collect()
}

fn extract_search_term(text: &str, categories: &[String], tags: &[String]) -> Option<String> {
    let stopwords = [
        "search",
        "find",
        "lookup",
        "list",
        "show",
        "contact",
        "contacts",
        "relationship",
        "relationships",
        "people",
        "person",
        "my",
        "all",
        "for",
        "in",
        "with",
        "please",
        "known",
        "saved",
        "stored",
        "named",
        "called",
    ];

    let tokens = text
        .split_whitespace()
        .filter_map(|word| {
            let cleaned = word
                .trim_matches(|ch: char| !ch.is_alphanumeric() && ch != '-' && ch != '_')
                .to_lowercase();
            if cleaned.is_empty()
                || stopwords.contains(&cleaned.as_str())
                || categories.iter().any(|category| category == &cleaned)
                || tags.iter().any(|tag| tag == &cleaned)
            {
                None
            } else {
                Some(cleaned)
            }
        })
        .collect::<Vec<_>>();

    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    }
}

fn json_value_matches_search_term(value: &Value, search_term: &str) -> bool {
    match value {
        Value::String(text) => {
            let normalized = text.to_lowercase();
            normalized.contains(search_term) || search_term.contains(&normalized)
        }
        Value::Array(values) => values
            .iter()
            .any(|item| json_value_matches_search_term(item, search_term)),
        Value::Object(values) => values
            .values()
            .any(|item| json_value_matches_search_term(item, search_term)),
        _ => false,
    }
}

fn determine_follow_up_time(text: &str) -> DateTime<Utc> {
    let lower = text.to_lowercase();
    if lower.contains("tomorrow") {
        Utc::now() + Duration::days(1)
    } else if lower.contains("next week") || lower.contains("7 days") {
        Utc::now() + Duration::days(7)
    } else if lower.contains("month") || lower.contains("30 days") {
        Utc::now() + Duration::days(30)
    } else {
        Utc::now() + Duration::days(3)
    }
}

fn text_contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn has_relationship_context(text: &str) -> bool {
    text_contains_any(
        text,
        &[
            "contact",
            "contacts",
            "relationship",
            "relationships",
            "friend",
            "friends",
            "family",
            "colleague",
            "coworker",
            "people",
            "person",
        ],
    )
}

fn summarize_contact(contact: &ContactInfo) -> String {
    let tags = if contact.tags.is_empty() {
        String::new()
    } else {
        format!(" tags: {}", contact.tags.join(", "))
    };
    format!(
        "{} [{}]{}",
        contact.entity_id,
        contact.categories.join(", "),
        tags
    )
}

fn downcast_service<T: 'static>(service: &Arc<dyn RuntimeService>) -> Option<&T> {
    service.as_any().downcast_ref::<T>()
}

fn entity_id_from_message(message: &Memory) -> Option<UUID> {
    (message.entity_id != UUID::default_uuid()).then(|| message.entity_id.clone())
}

async fn relationships_service(runtime: &AgentRuntime) -> Option<Arc<dyn RuntimeService>> {
    runtime.get_service("relationships").await
}

async fn follow_up_service(runtime: &AgentRuntime) -> Option<Arc<dyn RuntimeService>> {
    runtime.get_service("follow_up").await
}

/// Native relationships service with canonical naming.
pub struct RelationshipsService {
    contacts: Mutex<HashMap<UUID, ContactInfo>>,
    analytics: Mutex<HashMap<String, RelationshipAnalytics>>,
    categories: Mutex<Vec<ContactCategory>>,
}

impl RelationshipsService {
    /// Create a new relationships service.
    pub fn new() -> Self {
        Self {
            contacts: Mutex::new(HashMap::new()),
            analytics: Mutex::new(HashMap::new()),
            categories: Mutex::new(default_native_categories()),
        }
    }

    pub fn add_contact(
        &self,
        entity_id: UUID,
        categories: Vec<String>,
        preferences: Option<ContactPreferences>,
    ) -> ContactInfo {
        let contact = ContactInfo {
            entity_id: entity_id.clone(),
            categories,
            tags: Vec::new(),
            preferences: preferences.unwrap_or(ContactPreferences {
                preferred_channel: None,
                timezone: None,
                language: None,
                contact_frequency: None,
                do_not_disturb: false,
                notes: None,
            }),
            custom_fields: HashMap::new(),
            privacy_level: "private".to_string(),
            last_modified: Utc::now().to_rfc3339(),
        };
        self.contacts
            .lock()
            .expect("relationships lock poisoned")
            .insert(entity_id, contact.clone());
        contact
    }

    pub fn get_contact(&self, entity_id: &UUID) -> Option<ContactInfo> {
        self.contacts
            .lock()
            .expect("relationships lock poisoned")
            .get(entity_id)
            .cloned()
    }

    pub fn update_contact(
        &self,
        entity_id: &UUID,
        categories: Option<Vec<String>>,
        tags: Option<Vec<String>>,
        custom_fields: Option<HashMap<String, Value>>,
    ) -> Option<ContactInfo> {
        let mut contacts = self.contacts.lock().expect("relationships lock poisoned");
        let contact = contacts.get_mut(entity_id)?;
        if let Some(categories) = categories {
            contact.categories = categories;
        }
        if let Some(tags) = tags {
            contact.tags = tags;
        }
        if let Some(custom_fields) = custom_fields {
            contact.custom_fields.extend(custom_fields);
        }
        contact.last_modified = Utc::now().to_rfc3339();
        Some(contact.clone())
    }

    pub fn remove_contact(&self, entity_id: &UUID) -> bool {
        self.contacts
            .lock()
            .expect("relationships lock poisoned")
            .remove(entity_id)
            .is_some()
    }

    pub fn search_contacts(
        &self,
        categories: Option<&[String]>,
        tags: Option<&[String]>,
        search_term: Option<&str>,
    ) -> Vec<ContactInfo> {
        let normalized_search = search_term
            .map(str::trim)
            .filter(|term| !term.is_empty())
            .map(str::to_lowercase);

        self.contacts
            .lock()
            .expect("relationships lock poisoned")
            .values()
            .filter(|contact| {
                categories
                    .map(|required| {
                        required.iter().any(|category| {
                            contact
                                .categories
                                .iter()
                                .any(|existing| existing == category)
                        })
                    })
                    .unwrap_or(true)
            })
            .filter(|contact| {
                tags.map(|required| {
                    required
                        .iter()
                        .any(|tag| contact.tags.iter().any(|existing| existing == tag))
                })
                .unwrap_or(true)
            })
            .filter(|contact| {
                normalized_search
                    .as_ref()
                    .map(|search_term| {
                        contact
                            .entity_id
                            .as_str()
                            .to_lowercase()
                            .contains(search_term)
                            || contact
                                .categories
                                .iter()
                                .any(|category| category.contains(search_term))
                            || contact.tags.iter().any(|tag| tag.contains(search_term))
                            || contact
                                .custom_fields
                                .values()
                                .any(|value| json_value_matches_search_term(value, search_term))
                    })
                    .unwrap_or(true)
            })
            .cloned()
            .collect()
    }

    pub fn get_all_contacts(&self) -> Vec<ContactInfo> {
        self.contacts
            .lock()
            .expect("relationships lock poisoned")
            .values()
            .cloned()
            .collect()
    }

    pub fn get_relationship_analytics(&self, entity_id: &UUID) -> Option<RelationshipAnalytics> {
        self.analytics
            .lock()
            .expect("relationships analytics lock poisoned")
            .get(entity_id.as_str())
            .cloned()
    }

    pub fn update_relationship_analytics(
        &self,
        entity_id: &UUID,
        interaction_count: Option<u32>,
        last_interaction_at: Option<String>,
    ) -> RelationshipAnalytics {
        let mut analytics = self
            .analytics
            .lock()
            .expect("relationships analytics lock poisoned");
        let entry = analytics.entry(entity_id.as_str().to_string()).or_default();
        if let Some(interaction_count) = interaction_count {
            entry.interaction_count = interaction_count;
        }
        if let Some(last_interaction_at) = last_interaction_at {
            entry.last_interaction_at = Some(last_interaction_at);
        }

        let relationship_type = self
            .get_contact(entity_id)
            .and_then(|contact| contact.categories.first().cloned())
            .unwrap_or_else(|| "acquaintance".to_string());
        entry.strength = calculate_relationship_strength(
            entry.interaction_count,
            entry.last_interaction_at.as_deref(),
            &relationship_type,
        );
        entry.clone()
    }

    /// Analyze the relationship between two specific entities.
    ///
    /// Looks up the composite key `"source-target"` first, then merges
    /// per-entity analytics as a fallback. Returns `None` when neither entity
    /// has any recorded analytics.
    pub fn analyze_relationship(
        &self,
        source_entity_id: &UUID,
        target_entity_id: &UUID,
    ) -> Option<RelationshipAnalytics> {
        let analytics = self
            .analytics
            .lock()
            .expect("relationships analytics lock poisoned");

        // Composite key (canonical order so (a,b) == (b,a)).
        let composite = composite_analytics_key_native(source_entity_id, target_entity_id);
        if let Some(a) = analytics.get(&composite) {
            return Some(a.clone());
        }

        let source = analytics.get(source_entity_id.as_str());
        let target = analytics.get(target_entity_id.as_str());

        // Extract owned data while the lock is held, then drop it before
        // calling `get_contact` (which acquires the contacts lock).
        let merged = match (source, target) {
            (Some(s), Some(t)) => {
                let interaction_count = s.interaction_count + t.interaction_count;
                let last_interaction_at = match (&s.last_interaction_at, &t.last_interaction_at) {
                    (Some(a), Some(b)) => Some(a.max(b).clone()),
                    (Some(a), None) => Some(a.clone()),
                    (None, Some(b)) => Some(b.clone()),
                    (None, None) => None,
                };
                let sentiment_score = match (s.sentiment_score, t.sentiment_score) {
                    (Some(a), Some(b)) => Some((a + b) / 2.0),
                    (a, b) => a.or(b),
                };
                let average_response_time = s.average_response_time.or(t.average_response_time);
                let mut topics: Vec<String> = s.topics_discussed.clone();
                for topic in &t.topics_discussed {
                    if !topics.contains(topic) {
                        topics.push(topic.clone());
                    }
                }
                Some((
                    interaction_count,
                    last_interaction_at,
                    sentiment_score,
                    average_response_time,
                    topics,
                ))
            }
            (Some(a), None) | (None, Some(a)) => {
                let result = a.clone();
                drop(analytics);
                return Some(result);
            }
            (None, None) => {
                return None;
            }
        };

        drop(analytics); // release lock before calling get_contact

        let (
            interaction_count,
            last_interaction_at,
            sentiment_score,
            average_response_time,
            topics,
        ) = merged.expect("already handled None cases above");

        let relationship_type = self
            .get_contact(source_entity_id)
            .or_else(|| self.get_contact(target_entity_id))
            .and_then(|c| c.categories.first().cloned())
            .unwrap_or_else(|| "acquaintance".to_string());
        let strength = calculate_relationship_strength(
            interaction_count,
            last_interaction_at.as_deref(),
            &relationship_type,
        );
        Some(RelationshipAnalytics {
            strength,
            interaction_count,
            last_interaction_at,
            average_response_time,
            sentiment_score,
            topics_discussed: topics,
        })
    }

    /// Return categorized relationship insights for an entity.
    ///
    /// * **strongest_relationships** -- top 10 by strength score (descending).
    /// * **needs_attention** -- contacts with no interaction in 30+ days.
    /// * **recent_interactions** -- last 10 by interaction timestamp (newest first).
    pub fn get_relationship_insights(&self, entity_id: &UUID) -> RelationshipInsights {
        let analytics = self
            .analytics
            .lock()
            .expect("relationships analytics lock poisoned");

        let entity_key = entity_id.as_str();

        // Collect analytics for every *other* entity.
        let mut entries: Vec<(String, RelationshipAnalytics)> = analytics
            .iter()
            .filter(|(key, _)| key.as_str() != entity_key)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        // Strongest (top 10 by strength, descending).
        entries.sort_by(|a, b| {
            b.1.strength
                .partial_cmp(&a.1.strength)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let strongest_relationships: Vec<RelationshipInsightEntry> = entries
            .iter()
            .take(10)
            .map(|(id, a)| RelationshipInsightEntry {
                entity_id: UUID::new(id).expect("valid UUID from analytics key"),
                analytics: a.clone(),
            })
            .collect();

        // Needs attention (no interaction in 30+ days).
        let now = Utc::now();
        let needs_attention: Vec<NeedsAttentionEntry> = entries
            .iter()
            .filter_map(|(id, a)| {
                a.last_interaction_at.as_deref().and_then(|ts| {
                    DateTime::parse_from_rfc3339(ts).ok().and_then(|last| {
                        let days = (now - last.with_timezone(&Utc)).num_days();
                        if days >= 30 {
                            Some(NeedsAttentionEntry {
                                entity_id: UUID::new(id).expect("valid UUID from analytics key"),
                                days_since_contact: days,
                            })
                        } else {
                            None
                        }
                    })
                })
            })
            .collect();

        // Recent interactions (last 10, newest first).
        let mut with_interaction: Vec<(String, String)> = entries
            .iter()
            .filter_map(|(id, a)| {
                a.last_interaction_at
                    .as_ref()
                    .map(|ts| (id.clone(), ts.clone()))
            })
            .collect();
        with_interaction.sort_by(|a, b| b.1.cmp(&a.1));
        let recent_interactions: Vec<RecentInteractionEntry> = with_interaction
            .into_iter()
            .take(10)
            .map(|(id, ts)| RecentInteractionEntry {
                entity_id: UUID::new(&id).expect("valid UUID from analytics key"),
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
    pub fn get_categories(&self) -> Vec<ContactCategory> {
        self.categories
            .lock()
            .expect("categories lock poisoned")
            .clone()
    }

    /// Add a new contact category. Does nothing if a category with the same
    /// `id` already exists.
    pub fn add_category(&self, category: ContactCategory) {
        let mut cats = self.categories.lock().expect("categories lock poisoned");
        if cats.iter().any(|c| c.id == category.id) {
            return;
        }
        cats.push(category);
    }

    /// Set the privacy level on a contact. Returns `false` if the contact does
    /// not exist or the privacy level is invalid.
    pub fn set_contact_privacy(&self, entity_id: &UUID, privacy_level: &str) -> bool {
        if !matches!(privacy_level, "public" | "private" | "restricted") {
            return false;
        }
        let mut contacts = self.contacts.lock().expect("relationships lock poisoned");
        if let Some(contact) = contacts.get_mut(entity_id) {
            contact.privacy_level = privacy_level.to_string();
            contact.last_modified = Utc::now().to_rfc3339();
            true
        } else {
            false
        }
    }

    /// Check whether `requesting_entity_id` can access the contact record of
    /// `target_entity_id`.
    ///
    /// * `"public"` -- anyone can access.
    /// * `"private"` -- only the target entity itself.
    /// * `"restricted"` -- nobody (except the owning agent, which is checked
    ///   at a higher layer).
    pub fn can_access_contact(&self, requesting_entity_id: &UUID, target_entity_id: &UUID) -> bool {
        let contacts = self.contacts.lock().expect("relationships lock poisoned");
        let contact = match contacts.get(target_entity_id) {
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

/// Canonical composite key for a pair of entity IDs (order-independent).
fn composite_analytics_key_native(a: &UUID, b: &UUID) -> String {
    let (lo, hi) = if a.as_str() <= b.as_str() {
        (a.as_str(), b.as_str())
    } else {
        (b.as_str(), a.as_str())
    };
    format!("{}-{}", lo, hi)
}

/// Default contact categories matching the TypeScript service.
fn default_native_categories() -> Vec<ContactCategory> {
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
impl RuntimeService for RelationshipsService {
    fn service_type(&self) -> &str {
        "relationships"
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn stop(&self) -> Result<()> {
        self.contacts
            .lock()
            .expect("relationships lock poisoned")
            .clear();
        self.analytics
            .lock()
            .expect("relationships analytics lock poisoned")
            .clear();
        self.categories
            .lock()
            .expect("categories lock poisoned")
            .clear();
        Ok(())
    }
}

/// Native follow-up service with canonical naming.
pub struct FollowUpServiceAdapter {
    tasks: Mutex<HashMap<UUID, FollowUpTask>>,
}

impl FollowUpServiceAdapter {
    /// Create a new follow-up service adapter.
    pub fn new() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
        }
    }

    pub fn schedule_follow_up(
        &self,
        entity_id: UUID,
        scheduled_at: DateTime<Utc>,
        reason: String,
        priority: String,
        message: Option<String>,
    ) -> FollowUpTask {
        let task = FollowUpTask {
            entity_id: entity_id.clone(),
            reason,
            message,
            priority,
            scheduled_at: scheduled_at.to_rfc3339(),
            metadata: HashMap::new(),
        };
        self.tasks
            .lock()
            .expect("follow-up lock poisoned")
            .insert(entity_id, task.clone());
        task
    }

    pub fn get_follow_up(&self, entity_id: &UUID) -> Option<FollowUpTask> {
        self.tasks
            .lock()
            .expect("follow-up lock poisoned")
            .get(entity_id)
            .cloned()
    }

    pub fn cancel_follow_up(&self, entity_id: &UUID) -> bool {
        self.tasks
            .lock()
            .expect("follow-up lock poisoned")
            .remove(entity_id)
            .is_some()
    }

    pub fn get_upcoming_follow_ups(
        &self,
        days_ahead: i64,
        include_overdue: bool,
    ) -> Vec<FollowUpTask> {
        let now = Utc::now();
        self.tasks
            .lock()
            .expect("follow-up lock poisoned")
            .values()
            .filter_map(|task| {
                let scheduled_at = DateTime::parse_from_rfc3339(&task.scheduled_at)
                    .ok()?
                    .with_timezone(&Utc);
                let delta_days = (scheduled_at - now).num_days();
                if (include_overdue && delta_days < 0) || (0..=days_ahead).contains(&delta_days) {
                    Some(task.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    pub fn get_overdue_follow_ups(&self) -> Vec<FollowUpTask> {
        let now = Utc::now();
        self.tasks
            .lock()
            .expect("follow-up lock poisoned")
            .values()
            .filter_map(|task| {
                let scheduled_at = DateTime::parse_from_rfc3339(&task.scheduled_at)
                    .ok()?
                    .with_timezone(&Utc);
                (scheduled_at < now).then(|| task.clone())
            })
            .collect()
    }

    pub fn complete_follow_up(&self, entity_id: &UUID) -> bool {
        self.cancel_follow_up(entity_id)
    }
}

impl Default for FollowUpServiceAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl RuntimeService for FollowUpServiceAdapter {
    fn service_type(&self) -> &str {
        "follow_up"
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn stop(&self) -> Result<()> {
        self.tasks.lock().expect("follow-up lock poisoned").clear();
        Ok(())
    }
}

/// Native trajectory logger service.
pub struct TrajectoriesService {
    runtime: Weak<AgentRuntime>,
}

impl TrajectoriesService {
    /// Create a new trajectory logger service.
    pub fn new(runtime: Weak<AgentRuntime>) -> Self {
        Self { runtime }
    }

    /// Get a snapshot of collected logs.
    pub fn get_logs(&self) -> Option<TrajectoryLogs> {
        self.runtime
            .upgrade()
            .map(|runtime| runtime.get_trajectory_logs())
    }
}

#[async_trait]
impl RuntimeService for TrajectoriesService {
    fn service_type(&self) -> &str {
        "trajectories"
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn stop(&self) -> Result<()> {
        Ok(())
    }
}

struct KnowledgeProviderHandler {
    runtime: Weak<AgentRuntime>,
}

#[async_trait]
impl ProviderHandler for KnowledgeProviderHandler {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "KNOWLEDGE".to_string(),
            description: Some(
                "Retrieves relevant knowledge snippets for the current message".to_string(),
            ),
            dynamic: Some(true),
            position: Some(50),
            private: Some(false),
        }
    }

    async fn get(&self, message: &Memory, _state: &State) -> Result<ProviderResult> {
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(ProviderResult::default());
        };
        let Some(adapter) = runtime.get_adapter() else {
            return Ok(ProviderResult::default());
        };
        let query = message.content.text.clone().unwrap_or_default();
        if query.trim().is_empty() {
            return Ok(ProviderResult::default());
        }

        let memories = adapter
            .search_memories(SearchMemoriesParams {
                embedding: Vec::new(),
                match_threshold: None,
                count: Some(5),
                unique: Some(true),
                table_name: "knowledge".to_string(),
                query: Some(query.clone()),
                room_id: None,
                world_id: None,
                entity_id: None,
            })
            .await
            .unwrap_or_default();

        if memories.is_empty() {
            return Ok(ProviderResult::default());
        }

        let snippets = memories
            .iter()
            .filter_map(|memory| memory.content.text.clone())
            .take(5)
            .collect::<Vec<_>>();
        if snippets.is_empty() {
            return Ok(ProviderResult::default());
        }

        Ok(ProviderResult::with_text(snippets.join("\n\n"))
            .with_value("knowledgeMatches", json!(snippets.len())))
    }
}

struct ContactsProviderHandler {
    runtime: Weak<AgentRuntime>,
}

#[async_trait]
impl ProviderHandler for ContactsProviderHandler {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "CONTACTS".to_string(),
            description: Some("Lists known contact relationships".to_string()),
            dynamic: Some(true),
            position: Some(60),
            private: Some(false),
        }
    }

    async fn get(&self, message: &Memory, _state: &State) -> Result<ProviderResult> {
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(ProviderResult::default());
        };
        let Some(service) = relationships_service(runtime.as_ref()).await else {
            return Ok(ProviderResult::default());
        };
        let Some(relationships) = downcast_service::<RelationshipsService>(&service) else {
            return Ok(ProviderResult::default());
        };

        let contacts = if let Some(entity_id) = entity_id_from_message(message) {
            relationships
                .get_contact(&entity_id)
                .into_iter()
                .collect::<Vec<_>>()
        } else {
            relationships.get_all_contacts()
        };
        if contacts.is_empty() {
            return Ok(ProviderResult::default());
        }

        let summaries = contacts.iter().map(summarize_contact).collect::<Vec<_>>();
        Ok(ProviderResult::with_text(summaries.join("\n"))
            .with_value("contactCount", json!(summaries.len())))
    }
}

struct FactsProviderHandler {
    runtime: Weak<AgentRuntime>,
}

#[async_trait]
impl ProviderHandler for FactsProviderHandler {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "FACTS".to_string(),
            description: Some(
                "Summarizes stored relationship facts for the current entity".to_string(),
            ),
            dynamic: Some(true),
            position: Some(61),
            private: Some(false),
        }
    }

    async fn get(&self, message: &Memory, _state: &State) -> Result<ProviderResult> {
        let Some(entity_id) = entity_id_from_message(message) else {
            return Ok(ProviderResult::default());
        };
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(ProviderResult::default());
        };
        let Some(service) = relationships_service(runtime.as_ref()).await else {
            return Ok(ProviderResult::default());
        };
        let Some(relationships) = downcast_service::<RelationshipsService>(&service) else {
            return Ok(ProviderResult::default());
        };
        let Some(contact) = relationships.get_contact(&entity_id) else {
            return Ok(ProviderResult::default());
        };

        let mut facts = vec![format!("categories: {}", contact.categories.join(", "))];
        if !contact.tags.is_empty() {
            facts.push(format!("tags: {}", contact.tags.join(", ")));
        }
        for (key, value) in &contact.custom_fields {
            facts.push(format!("{key}: {value}"));
        }

        Ok(ProviderResult::with_text(facts.join("\n")))
    }
}

struct FollowUpsProviderHandler {
    runtime: Weak<AgentRuntime>,
}

#[async_trait]
impl ProviderHandler for FollowUpsProviderHandler {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "FOLLOW_UPS".to_string(),
            description: Some("Lists pending relationship follow-ups".to_string()),
            dynamic: Some(true),
            position: Some(62),
            private: Some(false),
        }
    }

    async fn get(&self, _message: &Memory, _state: &State) -> Result<ProviderResult> {
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(ProviderResult::default());
        };
        let Some(service) = follow_up_service(runtime.as_ref()).await else {
            return Ok(ProviderResult::default());
        };
        let Some(follow_ups) = downcast_service::<FollowUpServiceAdapter>(&service) else {
            return Ok(ProviderResult::default());
        };

        let tasks = follow_ups.get_upcoming_follow_ups(14, true);
        if tasks.is_empty() {
            return Ok(ProviderResult::default());
        }

        let text = tasks
            .iter()
            .map(|task| {
                format!(
                    "{} at {} ({})",
                    task.entity_id, task.scheduled_at, task.reason
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        Ok(ProviderResult::with_text(text).with_value("followUpCount", json!(tasks.len())))
    }
}

struct RelationshipsProviderHandler {
    runtime: Weak<AgentRuntime>,
}

#[async_trait]
impl ProviderHandler for RelationshipsProviderHandler {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "RELATIONSHIPS".to_string(),
            description: Some("Summarizes relationship analytics and contact status".to_string()),
            dynamic: Some(true),
            position: Some(63),
            private: Some(false),
        }
    }

    async fn get(&self, message: &Memory, _state: &State) -> Result<ProviderResult> {
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(ProviderResult::default());
        };
        let Some(service) = relationships_service(runtime.as_ref()).await else {
            return Ok(ProviderResult::default());
        };
        let Some(relationships) = downcast_service::<RelationshipsService>(&service) else {
            return Ok(ProviderResult::default());
        };

        if let Some(entity_id) = entity_id_from_message(message) {
            let analytics = relationships.get_relationship_analytics(&entity_id);
            let text = match (relationships.get_contact(&entity_id), analytics) {
                (Some(contact), Some(analytics)) => format!(
                    "{} strength={} interactions={}",
                    summarize_contact(&contact),
                    analytics.strength,
                    analytics.interaction_count
                ),
                (Some(contact), None) => summarize_contact(&contact),
                _ => return Ok(ProviderResult::default()),
            };
            return Ok(ProviderResult::with_text(text));
        }

        let contacts = relationships.get_all_contacts();
        Ok(ProviderResult::with_text(format!(
            "{} tracked relationships",
            contacts.len()
        )))
    }
}

struct AddContactActionHandler {
    runtime: Weak<AgentRuntime>,
}

#[async_trait]
impl ActionHandler for AddContactActionHandler {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "ADD_CONTACT".to_string(),
            description: "Add the current entity to the relationships service".to_string(),
            similes: Some(vec!["SAVE_CONTACT".to_string()]),
            ..Default::default()
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        let text = message
            .content
            .text
            .clone()
            .unwrap_or_default()
            .to_lowercase();
        entity_id_from_message(message).is_some()
            && has_relationship_context(&text)
            && text_contains_any(&text, &["add", "save", "remember", "track"])
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let Some(entity_id) = entity_id_from_message(message) else {
            return Ok(Some(ActionResult::failure("No entity specified.")));
        };
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(None);
        };
        let Some(service) = relationships_service(runtime.as_ref()).await else {
            return Ok(None);
        };
        let Some(relationships) = downcast_service::<RelationshipsService>(&service) else {
            return Ok(None);
        };
        let text = message.content.text.clone().unwrap_or_default();
        let contact = relationships.add_contact(entity_id.clone(), extract_categories(&text), None);
        if let Some(adapter) = runtime.get_adapter() {
            if let Ok(Some(entity)) = adapter.get_entity(&entity_id).await {
                if let Some(display_name) = entity.names.and_then(|names| names.into_iter().next())
                {
                    let mut custom_fields = HashMap::new();
                    custom_fields.insert("display_name".to_string(), json!(display_name));
                    let _ =
                        relationships.update_contact(&entity_id, None, None, Some(custom_fields));
                }
            }
        }
        relationships.update_relationship_analytics(
            &entity_id,
            Some(1),
            Some(Utc::now().to_rfc3339()),
        );

        Ok(Some(
            ActionResult::success(format!("Added {} to relationships.", entity_id))
                .with_data("entityId", entity_id.to_string())
                .with_data("categories", json!(contact.categories)),
        ))
    }
}

struct RemoveContactActionHandler {
    runtime: Weak<AgentRuntime>,
}

#[async_trait]
impl ActionHandler for RemoveContactActionHandler {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "REMOVE_CONTACT".to_string(),
            description: "Remove the current entity from the relationships service".to_string(),
            similes: Some(vec!["DELETE_CONTACT".to_string()]),
            ..Default::default()
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        let text = message
            .content
            .text
            .clone()
            .unwrap_or_default()
            .to_lowercase();
        entity_id_from_message(message).is_some()
            && has_relationship_context(&text)
            && text_contains_any(&text, &["remove", "delete", "forget", "drop"])
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let Some(entity_id) = entity_id_from_message(message) else {
            return Ok(Some(ActionResult::failure("No entity specified.")));
        };
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(None);
        };
        let Some(service) = relationships_service(runtime.as_ref()).await else {
            return Ok(None);
        };
        let Some(relationships) = downcast_service::<RelationshipsService>(&service) else {
            return Ok(None);
        };
        let removed = relationships.remove_contact(&entity_id);

        Ok(Some(
            if removed {
                ActionResult::success(format!("Removed {} from relationships.", entity_id))
            } else {
                ActionResult::failure("Contact not found.")
            }
            .with_data("entityId", entity_id.to_string()),
        ))
    }
}

struct SearchContactsActionHandler {
    runtime: Weak<AgentRuntime>,
}

#[async_trait]
impl ActionHandler for SearchContactsActionHandler {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "SEARCH_CONTACTS".to_string(),
            description: "Search stored contacts by inferred names, categories, or tags"
                .to_string(),
            ..Default::default()
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        let text = message
            .content
            .text
            .clone()
            .unwrap_or_default()
            .to_lowercase();
        has_relationship_context(&text)
            && text_contains_any(&text, &["search", "find", "lookup", "list", "show"])
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(None);
        };
        let Some(service) = relationships_service(runtime.as_ref()).await else {
            return Ok(None);
        };
        let Some(relationships) = downcast_service::<RelationshipsService>(&service) else {
            return Ok(None);
        };

        let text = message.content.text.clone().unwrap_or_default();
        let categories = extract_explicit_categories(&text);
        let tags = extract_tags(&text);
        let search_term = extract_search_term(&text, &categories, &tags);
        let results = relationships.search_contacts(
            (!categories.is_empty()).then_some(categories.as_slice()),
            (!tags.is_empty()).then_some(tags.as_slice()),
            search_term.as_deref(),
        );

        Ok(Some(
            ActionResult::success(format!("Found {} matching contacts.", results.len())).with_data(
                "contacts",
                json!(results.iter().map(summarize_contact).collect::<Vec<_>>()),
            ),
        ))
    }
}

struct ScheduleFollowUpActionHandler {
    runtime: Weak<AgentRuntime>,
}

#[async_trait]
impl ActionHandler for ScheduleFollowUpActionHandler {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "SCHEDULE_FOLLOW_UP".to_string(),
            description: "Schedule a relationship follow-up for the current entity".to_string(),
            ..Default::default()
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        let text = message
            .content
            .text
            .clone()
            .unwrap_or_default()
            .to_lowercase();
        entity_id_from_message(message).is_some()
            && has_relationship_context(&text)
            && text_contains_any(&text, &["follow up", "check in", "remind", "schedule"])
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let Some(entity_id) = entity_id_from_message(message) else {
            return Ok(Some(ActionResult::failure("No entity specified.")));
        };
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(None);
        };
        let Some(service) = follow_up_service(runtime.as_ref()).await else {
            return Ok(None);
        };
        let Some(follow_ups) = downcast_service::<FollowUpServiceAdapter>(&service) else {
            return Ok(None);
        };

        let text = message.content.text.clone().unwrap_or_default();
        let scheduled_at = determine_follow_up_time(&text);
        let task = follow_ups.schedule_follow_up(
            entity_id.clone(),
            scheduled_at,
            if text.trim().is_empty() {
                "relationship follow-up".to_string()
            } else {
                text.clone()
            },
            "medium".to_string(),
            None,
        );

        Ok(Some(
            ActionResult::success(format!("Scheduled follow-up for {}.", entity_id))
                .with_data("entityId", entity_id.to_string())
                .with_data("scheduledAt", task.scheduled_at),
        ))
    }
}

struct SendMessageActionHandler {
    runtime: Weak<AgentRuntime>,
}

#[async_trait]
impl ActionHandler for SendMessageActionHandler {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "SEND_MESSAGE".to_string(),
            description: "Prepare a relationship-targeted outbound message".to_string(),
            ..Default::default()
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        let text = message
            .content
            .text
            .clone()
            .unwrap_or_default()
            .to_lowercase();
        entity_id_from_message(message).is_some()
            && has_relationship_context(&text)
            && text_contains_any(&text, &["send", "message", "reach out", "contact"])
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let Some(entity_id) = entity_id_from_message(message) else {
            return Ok(Some(ActionResult::failure("No entity specified.")));
        };
        let Some(_runtime) = self.runtime.upgrade() else {
            return Ok(None);
        };
        let outbound_text = message
            .content
            .text
            .clone()
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| "Checking in.".to_string());

        Ok(Some(
            ActionResult::success(format!("Prepared outbound message for {}.", entity_id))
                .with_data("entityId", entity_id.to_string())
                .with_data("message", outbound_text)
                .with_value("queued", true),
        ))
    }
}

struct UpdateContactActionHandler {
    runtime: Weak<AgentRuntime>,
}

#[async_trait]
impl ActionHandler for UpdateContactActionHandler {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "UPDATE_CONTACT".to_string(),
            description: "Update categories or tags for the current relationship".to_string(),
            ..Default::default()
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        let text = message
            .content
            .text
            .clone()
            .unwrap_or_default()
            .to_lowercase();
        entity_id_from_message(message).is_some()
            && has_relationship_context(&text)
            && text_contains_any(&text, &["update", "edit", "change", "tag", "category"])
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let Some(entity_id) = entity_id_from_message(message) else {
            return Ok(Some(ActionResult::failure("No entity specified.")));
        };
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(None);
        };
        let Some(service) = relationships_service(runtime.as_ref()).await else {
            return Ok(None);
        };
        let Some(relationships) = downcast_service::<RelationshipsService>(&service) else {
            return Ok(None);
        };
        let text = message.content.text.clone().unwrap_or_default();
        let updated = relationships.update_contact(
            &entity_id,
            Some(extract_categories(&text)),
            Some(extract_tags(&text)),
            None,
        );

        Ok(Some(match updated {
            Some(contact) => ActionResult::success(format!("Updated {}.", entity_id))
                .with_data("categories", json!(contact.categories))
                .with_data("tags", json!(contact.tags)),
            None => ActionResult::failure("Contact not found."),
        }))
    }
}

struct UpdateEntityActionHandler {
    runtime: Weak<AgentRuntime>,
}

#[async_trait]
impl ActionHandler for UpdateEntityActionHandler {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "UPDATE_ENTITY".to_string(),
            description: "Record entity notes alongside the current relationship".to_string(),
            ..Default::default()
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        let text = message
            .content
            .text
            .clone()
            .unwrap_or_default()
            .to_lowercase();
        entity_id_from_message(message).is_some()
            && has_relationship_context(&text)
            && text_contains_any(&text, &["update", "record", "note", "remember", "profile"])
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let Some(entity_id) = entity_id_from_message(message) else {
            return Ok(Some(ActionResult::failure("No entity specified.")));
        };
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(None);
        };
        let Some(service) = relationships_service(runtime.as_ref()).await else {
            return Ok(None);
        };
        let Some(relationships) = downcast_service::<RelationshipsService>(&service) else {
            return Ok(None);
        };

        let note = message.content.text.clone().unwrap_or_default();
        let mut custom_fields = HashMap::new();
        custom_fields.insert("entity_note".to_string(), json!(note));
        let updated = relationships.update_contact(&entity_id, None, None, Some(custom_fields));

        Ok(Some(match updated {
            Some(_) => ActionResult::success(format!("Recorded entity update for {}.", entity_id))
                .with_data("entityId", entity_id.to_string()),
            None => ActionResult::failure("Contact not found."),
        }))
    }
}

struct ReflectionEvaluatorHandler {
    runtime: Weak<AgentRuntime>,
}

#[async_trait]
impl EvaluatorHandler for ReflectionEvaluatorHandler {
    fn definition(&self) -> EvaluatorDefinition {
        EvaluatorDefinition {
            name: "REFLECTION".to_string(),
            description: "Identify relationship-management intent in the current message"
                .to_string(),
            always_run: Some(false),
            similes: Some(vec!["RELATIONSHIP_REFLECTION".to_string()]),
            examples: Vec::new(),
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        let text = message
            .content
            .text
            .clone()
            .unwrap_or_default()
            .to_lowercase();
        ["contact", "follow up", "relationship", "friend", "family"]
            .iter()
            .any(|needle| text.contains(needle))
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let Some(_runtime) = self.runtime.upgrade() else {
            return Ok(None);
        };
        Ok(Some(
            ActionResult::success("Relationship intent detected.")
                .with_data("message", message.content.text.clone().unwrap_or_default()),
        ))
    }
}

struct RelationshipExtractionEvaluatorHandler {
    runtime: Weak<AgentRuntime>,
}

#[async_trait]
impl EvaluatorHandler for RelationshipExtractionEvaluatorHandler {
    fn definition(&self) -> EvaluatorDefinition {
        EvaluatorDefinition {
            name: "RELATIONSHIP_EXTRACTION".to_string(),
            description: "Update relationship analytics from the latest interaction".to_string(),
            always_run: Some(true),
            similes: Some(vec!["RELATIONSHIP_MEMORY".to_string()]),
            examples: Vec::new(),
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        entity_id_from_message(message).is_some() && message.content.text.is_some()
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let Some(entity_id) = entity_id_from_message(message) else {
            return Ok(None);
        };
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(None);
        };
        let Some(service) = relationships_service(runtime.as_ref()).await else {
            return Ok(None);
        };
        let Some(relationships) = downcast_service::<RelationshipsService>(&service) else {
            return Ok(None);
        };

        if relationships.get_contact(&entity_id).is_none() {
            relationships.add_contact(
                entity_id.clone(),
                extract_categories(&message.content.text.clone().unwrap_or_default()),
                None,
            );
        }

        let next_count = relationships
            .get_relationship_analytics(&entity_id)
            .map(|analytics| analytics.interaction_count + 1)
            .unwrap_or(1);
        let analytics = relationships.update_relationship_analytics(
            &entity_id,
            Some(next_count),
            Some(Utc::now().to_rfc3339()),
        );

        Ok(Some(
            ActionResult::success("Relationship analytics updated.")
                .with_data("entityId", entity_id.to_string())
                .with_data("strength", analytics.strength),
        ))
    }
}

/// Create the native knowledge plugin.
pub fn create_knowledge_plugin(runtime: Weak<AgentRuntime>) -> Plugin {
    Plugin::new("knowledge", "Native knowledge retrieval capabilities")
        .with_provider(Arc::new(KnowledgeProviderHandler { runtime }))
}

/// Create the native relationships plugin.
pub fn create_relationships_plugin(runtime: Weak<AgentRuntime>) -> Plugin {
    Plugin::new(
        "relationships",
        "Native relationship, contact, and follow-up capabilities",
    )
    .with_action(Arc::new(AddContactActionHandler {
        runtime: runtime.clone(),
    }))
    .with_action(Arc::new(RemoveContactActionHandler {
        runtime: runtime.clone(),
    }))
    .with_action(Arc::new(SearchContactsActionHandler {
        runtime: runtime.clone(),
    }))
    .with_action(Arc::new(ScheduleFollowUpActionHandler {
        runtime: runtime.clone(),
    }))
    .with_action(Arc::new(SendMessageActionHandler {
        runtime: runtime.clone(),
    }))
    .with_action(Arc::new(UpdateContactActionHandler {
        runtime: runtime.clone(),
    }))
    .with_action(Arc::new(UpdateEntityActionHandler {
        runtime: runtime.clone(),
    }))
    .with_provider(Arc::new(ContactsProviderHandler {
        runtime: runtime.clone(),
    }))
    .with_provider(Arc::new(FactsProviderHandler {
        runtime: runtime.clone(),
    }))
    .with_provider(Arc::new(FollowUpsProviderHandler {
        runtime: runtime.clone(),
    }))
    .with_provider(Arc::new(RelationshipsProviderHandler {
        runtime: runtime.clone(),
    }))
    .with_evaluator(Arc::new(ReflectionEvaluatorHandler {
        runtime: runtime.clone(),
    }))
    .with_evaluator(Arc::new(RelationshipExtractionEvaluatorHandler { runtime }))
}

/// Create the native trajectories plugin.
pub fn create_trajectories_plugin() -> Plugin {
    Plugin::new("trajectories", "Native trajectory logging capabilities")
}
