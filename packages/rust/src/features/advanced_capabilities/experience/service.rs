//! ExperienceService — manages experience storage and retrieval.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use super::types::{
    Experience, ExperienceAnalysis, ExperienceEvent, ExperienceEventType, ExperienceQuery,
    ExperienceType, OutcomeType,
};

/// In-memory experience store.
///
/// Production deployments would back this with a database adapter;
/// this reference implementation keeps experiences in an `Arc<RwLock<>>` map
/// so that the action, provider, and evaluator can share state.
pub struct ExperienceService {
    experiences: Arc<RwLock<HashMap<Uuid, Experience>>>,
}

impl ExperienceService {
    /// Create a new, empty experience service.
    pub fn new() -> Self {
        Self {
            experiences: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Record a new experience and return the generated event.
    pub async fn record(&self, experience: Experience) -> anyhow::Result<ExperienceEvent> {
        let id = experience.id;
        let now = chrono::Utc::now().timestamp_millis();

        // Handle superseding
        if let Some(superseded_id) = experience.supersedes {
            let mut store = self.experiences.write().await;
            if let Some(old) = store.get_mut(&superseded_id) {
                old.updated_at = now;
            }
        }

        self.experiences.write().await.insert(id, experience);

        Ok(ExperienceEvent {
            experience_id: id,
            event_type: ExperienceEventType::Created,
            timestamp: now,
            metadata: None,
        })
    }

    /// Search experiences matching a query.
    pub async fn search(&self, query: &ExperienceQuery) -> anyhow::Result<Vec<Experience>> {
        let store = self.experiences.read().await;
        let mut results: Vec<Experience> = store
            .values()
            .filter(|exp| {
                // Filter by type
                if let Some(types) = &query.experience_type {
                    if !types.contains(&exp.experience_type) {
                        return false;
                    }
                }
                // Filter by outcome
                if let Some(outcomes) = &query.outcome {
                    if !outcomes.contains(&exp.outcome) {
                        return false;
                    }
                }
                // Filter by domain
                if let Some(domains) = &query.domain {
                    if !domains.contains(&exp.domain) {
                        return false;
                    }
                }
                // Filter by tags
                if let Some(tags) = &query.tags {
                    if !tags.iter().any(|t| exp.tags.contains(t)) {
                        return false;
                    }
                }
                // Filter by importance
                if let Some(min) = query.min_importance {
                    if exp.importance < min {
                        return false;
                    }
                }
                // Filter by confidence
                if let Some(min) = query.min_confidence {
                    if exp.confidence < min {
                        return false;
                    }
                }
                // Filter by time range
                if let Some(range) = &query.time_range {
                    if let Some(start) = range.start {
                        if exp.created_at < start {
                            return false;
                        }
                    }
                    if let Some(end) = range.end {
                        if exp.created_at > end {
                            return false;
                        }
                    }
                }
                true
            })
            .cloned()
            .collect();

        // Sort by importance descending
        results.sort_by(|a, b| {
            b.importance
                .partial_cmp(&a.importance)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        if let Some(limit) = query.limit {
            results.truncate(limit);
        }

        Ok(results)
    }

    /// Get a single experience by ID.
    pub async fn get(&self, id: Uuid) -> anyhow::Result<Option<Experience>> {
        let mut store = self.experiences.write().await;
        if let Some(exp) = store.get_mut(&id) {
            exp.access_count += 1;
            exp.last_accessed_at = Some(chrono::Utc::now().timestamp_millis());
            Ok(Some(exp.clone()))
        } else {
            Ok(None)
        }
    }

    /// Analyze experiences matching a query.
    pub async fn analyze(&self, query: &ExperienceQuery) -> anyhow::Result<ExperienceAnalysis> {
        let experiences = self.search(query).await?;

        if experiences.is_empty() {
            return Ok(ExperienceAnalysis::default());
        }

        let total = experiences.len() as f64;
        let successes = experiences
            .iter()
            .filter(|e| e.outcome == OutcomeType::Positive)
            .count() as f64;

        let reliability = successes / total;

        // Collect unique learnings as recommendations
        let recommendations: Vec<String> = experiences
            .iter()
            .filter(|e| !e.learning.is_empty())
            .map(|e| e.learning.clone())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .take(5)
            .collect();

        Ok(ExperienceAnalysis {
            pattern: Some(format!(
                "{} experiences found, {:.0}% positive outcomes",
                total,
                reliability * 100.0
            )),
            frequency: Some(total),
            reliability: Some(reliability),
            alternatives: None,
            recommendations: if recommendations.is_empty() {
                None
            } else {
                Some(recommendations)
            },
        })
    }

    /// Get count of experiences.
    pub async fn count(&self) -> usize {
        self.experiences.read().await.len()
    }
}

impl Default for ExperienceService {
    fn default() -> Self {
        Self::new()
    }
}
