//! Trust evaluator — evaluates trust signals from conversations.

use async_trait::async_trait;
use std::sync::Arc;
use uuid::Uuid;

use crate::basic_capabilities::evaluators::Evaluator;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{EvaluatorResult, Memory, State};

use super::security_module::SecurityModuleService;
use super::trust_engine::TrustEngineService;
use super::types::*;

/// Evaluator that detects trust-relevant signals in conversations
/// and records them as trust interactions or security events.
pub struct TrustEvaluator {
    engine: Arc<TrustEngineService>,
    security: Arc<SecurityModuleService>,
}

impl TrustEvaluator {
    /// Create a new TrustEvaluator.
    pub fn new(engine: Arc<TrustEngineService>, security: Arc<SecurityModuleService>) -> Self {
        Self { engine, security }
    }
}

#[async_trait]
impl Evaluator for TrustEvaluator {
    fn name(&self) -> &'static str {
        "TRUST"
    }

    fn description(&self) -> &'static str {
        "Evaluates trust signals from conversation and records trust interactions"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, message: &Memory) -> bool {
        message.entity_id.is_some()
    }

    async fn evaluate(
        &self,
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<EvaluatorResult> {
        let mut details = std::collections::HashMap::new();
        let entity_id = message.entity_id.unwrap(); // validated above

        let text = message.content.text.as_deref().unwrap_or("");

        // Detect positive trust signals
        let is_helpful =
            text.contains("thank") || text.contains("helped") || text.contains("useful");
        let is_consistent = true; // Would check history in production

        // Detect negative trust signals
        let is_suspicious =
            text.contains("hack") || text.contains("exploit") || text.contains("bypass security");
        let is_spam = text.len() > 5000 || text.chars().filter(|c| *c == '\n').count() > 100;

        let now = chrono::Utc::now().timestamp_millis();

        // Record security events for suspicious activity
        if is_suspicious {
            let event = SecurityEvent {
                id: Uuid::new_v4(),
                event_type: SecurityEventType::SuspiciousCommand,
                entity_id,
                timestamp: now,
                severity: SecuritySeverity::Medium,
                description: "Suspicious content detected in message".to_string(),
                context: TrustContext {
                    evaluator_id: runtime.agent_id(),
                    room_id: message.room_id,
                    ..Default::default()
                },
                resolved: false,
                resolution: None,
            };
            let _ = self.security.record_event(event).await;
            details.insert(
                "securityEvent".to_string(),
                serde_json::Value::String("SUSPICIOUS_COMMAND".to_string()),
            );
        }

        if is_spam {
            let event = SecurityEvent {
                id: Uuid::new_v4(),
                event_type: SecurityEventType::RateLimitExceeded,
                entity_id,
                timestamp: now,
                severity: SecuritySeverity::Low,
                description: "Potential spam: unusually large message".to_string(),
                context: TrustContext {
                    evaluator_id: runtime.agent_id(),
                    room_id: message.room_id,
                    ..Default::default()
                },
                resolved: false,
                resolution: None,
            };
            let _ = self.security.record_event(event).await;
        }

        // Record positive trust interactions
        if is_helpful {
            let interaction = TrustInteraction {
                source_entity_id: runtime.agent_id(),
                target_entity_id: entity_id,
                interaction_type: TrustEvidenceType::HelpfulAction,
                timestamp: now,
                impact: 5.0,
                details: None,
                context: Some(TrustContext {
                    evaluator_id: runtime.agent_id(),
                    room_id: message.room_id,
                    ..Default::default()
                }),
            };
            let _ = self.engine.record_interaction(interaction).await;
        }

        // Record negative trust interactions
        if is_suspicious {
            let interaction = TrustInteraction {
                source_entity_id: runtime.agent_id(),
                target_entity_id: entity_id,
                interaction_type: TrustEvidenceType::SuspiciousActivity,
                timestamp: now,
                impact: -20.0,
                details: None,
                context: Some(TrustContext {
                    evaluator_id: runtime.agent_id(),
                    room_id: message.room_id,
                    ..Default::default()
                }),
            };
            let _ = self.engine.record_interaction(interaction).await;
        }

        let threat_score = self.security.get_threat_score(entity_id).await;
        details.insert("threatScore".to_string(), serde_json::json!(threat_score));

        let score = if is_suspicious {
            20
        } else if is_helpful {
            80
        } else {
            50
        };

        Ok(EvaluatorResult {
            score,
            passed: !is_suspicious,
            reason: if is_suspicious {
                "Suspicious activity detected".to_string()
            } else if is_helpful {
                "Positive trust signal recorded".to_string()
            } else {
                "Neutral interaction".to_string()
            },
            details,
        })
    }
}
