//! Trust actions — RECORD_TRUST_INTERACTION, CHECK_TRUST.

use async_trait::async_trait;
use std::sync::Arc;
use uuid::Uuid;

use crate::basic_capabilities::actions::Action;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::trust_engine::TrustEngineService;
use super::types::*;

// ============================================================================
// RECORD_TRUST_INTERACTION
// ============================================================================

/// Action to record a trust-relevant interaction.
pub struct RecordTrustInteractionAction {
    engine: Arc<TrustEngineService>,
}

impl RecordTrustInteractionAction {
    /// Create a new RecordTrustInteractionAction.
    pub fn new(engine: Arc<TrustEngineService>) -> Self {
        Self { engine }
    }
}

#[async_trait]
impl Action for RecordTrustInteractionAction {
    fn name(&self) -> &'static str {
        "RECORD_TRUST_INTERACTION"
    }

    fn similes(&self) -> &[&'static str] {
        &["LOG_TRUST", "TRUST_EVENT", "UPDATE_TRUST"]
    }

    fn description(&self) -> &'static str {
        "Record a trust-relevant interaction to update an entity's trust profile"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let params = state
            .and_then(|s| s.get_value("actionParams"))
            .cloned()
            .unwrap_or_default();

        let target_entity_id = params
            .get("targetEntityId")
            .and_then(|v| v.as_str())
            .and_then(|s| Uuid::parse_str(s).ok())
            .or(message.entity_id)
            .ok_or_else(|| {
                crate::error::PluginError::InvalidInput(
                    "Missing targetEntityId parameter".to_string(),
                )
            })?;

        let evidence_type = params
            .get("type")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str::<TrustEvidenceType>(&format!("\"{}\"", s)).ok())
            .unwrap_or(TrustEvidenceType::HelpfulAction);

        let impact = params
            .get("impact")
            .and_then(|v| v.as_f64())
            .unwrap_or(10.0);

        let now = chrono::Utc::now().timestamp_millis();
        let interaction = TrustInteraction {
            source_entity_id: runtime.agent_id(),
            target_entity_id,
            interaction_type: evidence_type,
            timestamp: now,
            impact,
            details: params.get("details").cloned(),
            context: Some(TrustContext {
                evaluator_id: runtime.agent_id(),
                room_id: message.room_id,
                ..Default::default()
            }),
        };

        match self.engine.record_interaction(interaction).await {
            Ok(profile) => Ok(ActionResult::success(format!(
                "Trust updated for entity. Overall trust: {:.1}",
                profile.overall_trust
            ))
            .with_data("overallTrust", serde_json::json!(profile.overall_trust))
            .with_data("confidence", serde_json::json!(profile.confidence))
            .with_data("actionName", "RECORD_TRUST_INTERACTION")),
            Err(e) => Ok(ActionResult::error(format!(
                "Failed to record trust interaction: {}",
                e
            ))),
        }
    }
}

// ============================================================================
// CHECK_TRUST
// ============================================================================

/// Action to check if an entity meets trust requirements.
pub struct CheckTrustAction {
    engine: Arc<TrustEngineService>,
}

impl CheckTrustAction {
    /// Create a new CheckTrustAction.
    pub fn new(engine: Arc<TrustEngineService>) -> Self {
        Self { engine }
    }
}

#[async_trait]
impl Action for CheckTrustAction {
    fn name(&self) -> &'static str {
        "CHECK_TRUST"
    }

    fn similes(&self) -> &[&'static str] {
        &["VERIFY_TRUST", "TRUST_CHECK", "IS_TRUSTED"]
    }

    fn description(&self) -> &'static str {
        "Check if an entity meets specified trust requirements"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        _runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let params = state
            .and_then(|s| s.get_value("actionParams"))
            .cloned()
            .unwrap_or_default();

        let entity_id = params
            .get("entityId")
            .and_then(|v| v.as_str())
            .and_then(|s| Uuid::parse_str(s).ok())
            .or(message.entity_id)
            .ok_or_else(|| {
                crate::error::PluginError::InvalidInput("Missing entityId parameter".to_string())
            })?;

        let minimum_trust = params
            .get("minimumTrust")
            .and_then(|v| v.as_f64())
            .unwrap_or(50.0);

        let requirements = TrustRequirements {
            minimum_trust,
            dimensions: None,
            required_evidence: None,
            minimum_interactions: params.get("minimumInteractions").and_then(|v| v.as_u64()),
            minimum_confidence: params.get("minimumConfidence").and_then(|v| v.as_f64()),
        };

        let decision = self.engine.check_trust(entity_id, &requirements).await;

        Ok(ActionResult::success(decision.reason.clone())
            .with_value("allowed", decision.allowed)
            .with_data("trustScore", serde_json::json!(decision.trust_score))
            .with_data("requiredScore", serde_json::json!(decision.required_score))
            .with_data("reason", decision.reason)
            .with_data("actionName", "CHECK_TRUST"))
    }
}
