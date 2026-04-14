//! Trust providers — TRUST_PROFILE, SECURITY_STATUS.

use async_trait::async_trait;
use std::sync::Arc;

use crate::basic_capabilities::providers::Provider;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::security_module::SecurityModuleService;
use super::trust_engine::TrustEngineService;

// ============================================================================
// TRUST_PROFILE provider
// ============================================================================

/// Provider that surfaces the trust profile of the current entity.
pub struct TrustProfileProvider {
    engine: Arc<TrustEngineService>,
}

impl TrustProfileProvider {
    /// Create a new TrustProfileProvider.
    pub fn new(engine: Arc<TrustEngineService>) -> Self {
        Self { engine }
    }
}

#[async_trait]
impl Provider for TrustProfileProvider {
    fn name(&self) -> &'static str {
        "TRUST_PROFILE"
    }

    fn description(&self) -> &'static str {
        "Trust profile and scores for the current entity"
    }

    fn is_dynamic(&self) -> bool {
        true
    }

    async fn get(
        &self,
        _runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let entity_id = match message.entity_id {
            Some(id) => id,
            None => {
                return Ok(ProviderResult::new("").with_value("hasTrustProfile", false));
            }
        };

        let profile = match self.engine.get_profile(entity_id).await {
            Some(p) => p,
            None => {
                return Ok(ProviderResult::new("No trust profile available")
                    .with_value("hasTrustProfile", false));
            }
        };

        let text = format!(
            "# Trust Profile\n\
             Overall Trust: {:.1}/100 (confidence: {:.0}%)\n\
             Trend: {:?} ({:+.1} pts/day)\n\
             Interactions: {}\n\n\
             ## Dimensions\n\
             - Reliability: {:.1}\n\
             - Competence: {:.1}\n\
             - Integrity: {:.1}\n\
             - Benevolence: {:.1}\n\
             - Transparency: {:.1}\n",
            profile.overall_trust,
            profile.confidence * 100.0,
            profile.trend.direction,
            profile.trend.change_rate,
            profile.interaction_count,
            profile.dimensions.reliability,
            profile.dimensions.competence,
            profile.dimensions.integrity,
            profile.dimensions.benevolence,
            profile.dimensions.transparency,
        );

        Ok(ProviderResult::new(text)
            .with_value("hasTrustProfile", true)
            .with_value("overallTrust", profile.overall_trust as i64)
            .with_data(
                "trustProfile",
                serde_json::to_value(&profile).unwrap_or_default(),
            ))
    }
}

// ============================================================================
// SECURITY_STATUS provider
// ============================================================================

/// Provider that surfaces security status and recent events.
pub struct SecurityStatusProvider {
    security: Arc<SecurityModuleService>,
}

impl SecurityStatusProvider {
    /// Create a new SecurityStatusProvider.
    pub fn new(security: Arc<SecurityModuleService>) -> Self {
        Self { security }
    }
}

#[async_trait]
impl Provider for SecurityStatusProvider {
    fn name(&self) -> &'static str {
        "SECURITY_STATUS"
    }

    fn description(&self) -> &'static str {
        "Security status, threat assessment, and recent security events"
    }

    fn is_dynamic(&self) -> bool {
        true
    }

    async fn get(
        &self,
        _runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let recent_events = self.security.get_recent_events(5).await;

        let entity_threat = message.entity_id.map(|id| {
            // We can't await here directly, but we store a future
            // Use a sync approach: check the cached score
            id
        });

        let mut text = String::from("# Security Status\n");

        if let Some(entity_id) = entity_threat {
            let threat_score = self.security.get_threat_score(entity_id).await;
            text.push_str(&format!("Entity Threat Score: {:.1}/100\n", threat_score));
        }

        if recent_events.is_empty() {
            text.push_str("No recent security events.\n");
        } else {
            text.push_str("\n## Recent Events\n");
            for event in &recent_events {
                text.push_str(&format!(
                    "- [{:?}] {:?}: {} (resolved: {})\n",
                    event.severity, event.event_type, event.description, event.resolved
                ));
            }
        }

        Ok(ProviderResult::new(text).with_value("securityEventCount", recent_events.len() as i64))
    }
}
