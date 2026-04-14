//! TrustEngineService — calculates and manages trust profiles.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use super::types::*;

/// Service that calculates and manages trust profiles for entities.
pub struct TrustEngineService {
    profiles: Arc<RwLock<HashMap<Uuid, TrustProfile>>>,
    config: TrustCalculationConfig,
}

impl TrustEngineService {
    /// Create a new TrustEngineService with default configuration.
    pub fn new() -> Self {
        Self {
            profiles: Arc::new(RwLock::new(HashMap::new())),
            config: TrustCalculationConfig::default(),
        }
    }

    /// Create with custom configuration.
    pub fn with_config(config: TrustCalculationConfig) -> Self {
        Self {
            profiles: Arc::new(RwLock::new(HashMap::new())),
            config,
        }
    }

    /// Get a trust profile for an entity.
    pub async fn get_profile(&self, entity_id: Uuid) -> Option<TrustProfile> {
        self.profiles.read().await.get(&entity_id).cloned()
    }

    /// Record a trust interaction and update the profile.
    pub async fn record_interaction(
        &self,
        interaction: TrustInteraction,
    ) -> anyhow::Result<TrustProfile> {
        let now = chrono::Utc::now().timestamp_millis();
        let evaluator_id = interaction
            .context
            .as_ref()
            .map(|c| c.evaluator_id)
            .unwrap_or_default();

        let evidence = TrustEvidence {
            evidence_type: interaction.interaction_type.clone(),
            timestamp: interaction.timestamp,
            impact: interaction.impact,
            weight: 1.0,
            description: interaction
                .details
                .as_ref()
                .and_then(|d| d.get("description"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            reported_by: interaction.source_entity_id,
            verified: false,
            context: interaction.context.clone().unwrap_or_default(),
            target_entity_id: interaction.target_entity_id,
            evaluator_id,
            metadata: interaction.details.clone(),
        };

        let mut profiles = self.profiles.write().await;
        let profile = profiles
            .entry(interaction.target_entity_id)
            .or_insert_with(|| TrustProfile {
                entity_id: interaction.target_entity_id,
                dimensions: TrustDimensions::default(),
                overall_trust: 50.0,
                confidence: 0.0,
                interaction_count: 0,
                evidence: Vec::new(),
                last_calculated: now,
                calculation_method: "weighted_average".to_string(),
                trend: TrustTrend {
                    direction: TrustTrendDirection::Stable,
                    change_rate: 0.0,
                    last_change_at: now,
                },
                evaluator_id,
            });

        profile.evidence.push(evidence);
        profile.interaction_count += 1;

        // Recalculate trust
        self.recalculate_profile(profile);

        Ok(profile.clone())
    }

    /// Recalculate trust dimensions and overall score.
    fn recalculate_profile(&self, profile: &mut TrustProfile) {
        let now = chrono::Utc::now().timestamp_millis();
        let old_trust = profile.overall_trust;

        // Calculate weighted evidence impact per dimension
        let mut dim_scores = [0.0f64; 5]; // reliability, competence, integrity, benevolence, transparency
        let mut dim_weights = [0.0f64; 5];

        for evidence in &profile.evidence {
            let age_days = (now - evidence.timestamp) as f64 / (24.0 * 60.0 * 60.0 * 1000.0);
            let decay = (-age_days * self.config.evidence_decay_rate / 100.0).exp();
            let recency_weight =
                self.config.recency_bias * decay + (1.0 - self.config.recency_bias);
            let verification_weight = if evidence.verified {
                self.config.verification_multiplier
            } else {
                1.0
            };

            let total_weight = evidence.weight * recency_weight * verification_weight;
            let impact = evidence.impact * total_weight;

            // Map evidence types to dimensions
            match &evidence.evidence_type {
                TrustEvidenceType::PromiseKept | TrustEvidenceType::ConsistentBehavior => {
                    dim_scores[0] += impact;
                    dim_weights[0] += total_weight;
                }
                TrustEvidenceType::HelpfulAction | TrustEvidenceType::SuccessfulTransaction => {
                    dim_scores[1] += impact;
                    dim_weights[1] += total_weight;
                }
                TrustEvidenceType::VerifiedIdentity | TrustEvidenceType::CommunityContribution => {
                    dim_scores[2] += impact;
                    dim_weights[2] += total_weight;
                }
                TrustEvidenceType::PromiseBroken | TrustEvidenceType::InconsistentBehavior => {
                    dim_scores[0] += impact; // negative impact
                    dim_weights[0] += total_weight;
                }
                TrustEvidenceType::HarmfulAction | TrustEvidenceType::SecurityViolation => {
                    dim_scores[2] += impact;
                    dim_weights[2] += total_weight;
                    dim_scores[3] += impact;
                    dim_weights[3] += total_weight;
                }
                TrustEvidenceType::SpamBehavior | TrustEvidenceType::SuspiciousActivity => {
                    dim_scores[4] += impact;
                    dim_weights[4] += total_weight;
                }
                _ => {
                    // Neutral evidence - minor impact on transparency
                    dim_scores[4] += impact * 0.1;
                    dim_weights[4] += total_weight * 0.1;
                }
            }
        }

        // Normalize dimensions to 0-100 scale
        let base_score = 50.0;
        for i in 0..5 {
            if dim_weights[i] > 0.0 {
                dim_scores[i] = (base_score + dim_scores[i] / dim_weights[i]).clamp(0.0, 100.0);
            } else {
                dim_scores[i] = base_score;
            }
        }

        profile.dimensions = TrustDimensions {
            reliability: dim_scores[0],
            competence: dim_scores[1],
            integrity: dim_scores[2],
            benevolence: dim_scores[3],
            transparency: dim_scores[4],
        };

        // Calculate overall trust
        let w = &self.config.dimension_weights;
        profile.overall_trust = (profile.dimensions.reliability * w.reliability
            + profile.dimensions.competence * w.competence
            + profile.dimensions.integrity * w.integrity
            + profile.dimensions.benevolence * w.benevolence
            + profile.dimensions.transparency * w.transparency)
            .clamp(0.0, 100.0);

        // Calculate confidence
        let evidence_count = profile.evidence.len();
        profile.confidence = if evidence_count >= self.config.minimum_evidence_count {
            (evidence_count as f64 / (evidence_count as f64 + 10.0)).min(1.0)
        } else {
            evidence_count as f64 / self.config.minimum_evidence_count as f64 * 0.5
        };

        // Update trend
        let change = profile.overall_trust - old_trust;
        profile.trend = TrustTrend {
            direction: if change > 1.0 {
                TrustTrendDirection::Increasing
            } else if change < -1.0 {
                TrustTrendDirection::Decreasing
            } else {
                TrustTrendDirection::Stable
            },
            change_rate: change,
            last_change_at: now,
        };

        profile.last_calculated = now;
    }

    /// Make a trust-based decision.
    pub async fn check_trust(
        &self,
        entity_id: Uuid,
        requirements: &TrustRequirements,
    ) -> TrustDecision {
        let profile = self.profiles.read().await.get(&entity_id).cloned();

        match profile {
            Some(profile) => {
                let allowed = profile.overall_trust >= requirements.minimum_trust
                    && requirements
                        .minimum_confidence
                        .map(|min| profile.confidence >= min)
                        .unwrap_or(true)
                    && requirements
                        .minimum_interactions
                        .map(|min| profile.interaction_count >= min)
                        .unwrap_or(true);

                let reason = if allowed {
                    format!(
                        "Trust score {:.1} meets requirement of {:.1}",
                        profile.overall_trust, requirements.minimum_trust
                    )
                } else {
                    format!(
                        "Trust score {:.1} below requirement of {:.1}",
                        profile.overall_trust, requirements.minimum_trust
                    )
                };

                let suggestions = if !allowed {
                    Some(vec![
                        "Build trust through consistent, helpful interactions".to_string(),
                        "Verify your identity to boost trust score".to_string(),
                    ])
                } else {
                    None
                };

                TrustDecision {
                    allowed,
                    trust_score: profile.overall_trust,
                    required_score: requirements.minimum_trust,
                    dimensions_checked: profile.dimensions,
                    reason,
                    suggestions,
                }
            }
            None => TrustDecision {
                allowed: requirements.minimum_trust <= 0.0,
                trust_score: 0.0,
                required_score: requirements.minimum_trust,
                dimensions_checked: TrustDimensions::default(),
                reason: "No trust profile exists for this entity".to_string(),
                suggestions: Some(vec![
                    "Start interacting to build a trust profile".to_string()
                ]),
            },
        }
    }
}

impl Default for TrustEngineService {
    fn default() -> Self {
        Self::new()
    }
}
