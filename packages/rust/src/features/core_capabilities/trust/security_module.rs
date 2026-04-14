//! SecurityModuleService — tracks and manages security events.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use super::types::*;

/// Service that tracks security events and provides threat assessments.
pub struct SecurityModuleService {
    events: Arc<RwLock<Vec<SecurityEvent>>>,
    /// Entity-level threat scores (0-100).
    threat_scores: Arc<RwLock<HashMap<Uuid, f64>>>,
}

impl SecurityModuleService {
    /// Create a new SecurityModuleService.
    pub fn new() -> Self {
        Self {
            events: Arc::new(RwLock::new(Vec::new())),
            threat_scores: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Record a security event.
    pub async fn record_event(&self, event: SecurityEvent) -> anyhow::Result<()> {
        let entity_id = event.entity_id;
        let severity_weight = match event.severity {
            SecuritySeverity::Low => 5.0,
            SecuritySeverity::Medium => 15.0,
            SecuritySeverity::High => 30.0,
            SecuritySeverity::Critical => 50.0,
        };

        self.events.write().await.push(event);

        // Update threat score
        let mut scores = self.threat_scores.write().await;
        let score = scores.entry(entity_id).or_insert(0.0);
        *score = (*score + severity_weight).min(100.0);

        Ok(())
    }

    /// Get threat score for an entity.
    pub async fn get_threat_score(&self, entity_id: Uuid) -> f64 {
        self.threat_scores
            .read()
            .await
            .get(&entity_id)
            .copied()
            .unwrap_or(0.0)
    }

    /// Get recent security events.
    pub async fn get_recent_events(&self, limit: usize) -> Vec<SecurityEvent> {
        let events = self.events.read().await;
        events
            .iter()
            .rev()
            .take(limit)
            .cloned()
            .collect()
    }

    /// Get security events for a specific entity.
    pub async fn get_entity_events(&self, entity_id: Uuid) -> Vec<SecurityEvent> {
        self.events
            .read()
            .await
            .iter()
            .filter(|e| e.entity_id == entity_id)
            .cloned()
            .collect()
    }

    /// Resolve a security event.
    pub async fn resolve_event(
        &self,
        event_id: Uuid,
        resolution: &str,
    ) -> anyhow::Result<bool> {
        let mut events = self.events.write().await;
        if let Some(event) = events.iter_mut().find(|e| e.id == event_id) {
            event.resolved = true;
            event.resolution = Some(resolution.to_string());

            // Reduce threat score
            let entity_id = event.entity_id;
            let severity_reduction = match event.severity {
                SecuritySeverity::Low => 3.0,
                SecuritySeverity::Medium => 10.0,
                SecuritySeverity::High => 20.0,
                SecuritySeverity::Critical => 35.0,
            };

            let mut scores = self.threat_scores.write().await;
            if let Some(score) = scores.get_mut(&entity_id) {
                *score = (*score - severity_reduction).max(0.0);
            }

            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Check if an entity is considered a threat.
    pub async fn is_threat(&self, entity_id: Uuid, threshold: f64) -> bool {
        self.get_threat_score(entity_id).await >= threshold
    }
}

impl Default for SecurityModuleService {
    fn default() -> Self {
        Self::new()
    }
}
