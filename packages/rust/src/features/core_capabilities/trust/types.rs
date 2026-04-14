//! Trust types — Rust port of the TypeScript plugin-trust types.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ============================================================================
// Trust Dimensions
// ============================================================================

/// Core trust dimensions based on interpersonal trust theory.
/// Each dimension is a score from 0 to 100.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustDimensions {
    /// Consistency in behavior and promise keeping (0-100).
    pub reliability: f64,
    /// Ability to perform tasks and provide value (0-100).
    pub competence: f64,
    /// Adherence to ethical principles (0-100).
    pub integrity: f64,
    /// Good intentions towards others (0-100).
    pub benevolence: f64,
    /// Open and honest communication (0-100).
    pub transparency: f64,
}

// ============================================================================
// Trust Evidence
// ============================================================================

/// Evidence types that impact trust scores.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TrustEvidenceType {
    // Positive evidence
    PromiseKept,
    HelpfulAction,
    ConsistentBehavior,
    VerifiedIdentity,
    CommunityContribution,
    SuccessfulTransaction,
    // Negative evidence
    PromiseBroken,
    HarmfulAction,
    InconsistentBehavior,
    SuspiciousActivity,
    FailedVerification,
    SpamBehavior,
    SecurityViolation,
    // Neutral evidence
    IdentityChange,
    RoleChange,
    ContextSwitch,
}

/// A piece of evidence that affects trust.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustEvidence {
    #[serde(rename = "type")]
    pub evidence_type: TrustEvidenceType,
    pub timestamp: i64,
    /// Impact on trust score (-100 to +100).
    pub impact: f64,
    /// Weight/importance of this evidence (0-1).
    pub weight: f64,
    pub description: String,
    pub reported_by: Uuid,
    pub verified: bool,
    pub context: TrustContext,
    pub target_entity_id: Uuid,
    pub evaluator_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

// ============================================================================
// Trust Profile
// ============================================================================

/// Trust trend direction.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrustTrendDirection {
    Increasing,
    Decreasing,
    Stable,
}

/// Trust trend over time.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustTrend {
    pub direction: TrustTrendDirection,
    /// Points per day.
    pub change_rate: f64,
    pub last_change_at: i64,
}

/// Trust profile for an entity.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustProfile {
    pub entity_id: Uuid,
    pub dimensions: TrustDimensions,
    /// Overall trust score (0-100).
    pub overall_trust: f64,
    /// Confidence in the trust score (0-1).
    pub confidence: f64,
    pub interaction_count: u64,
    pub evidence: Vec<TrustEvidence>,
    pub last_calculated: i64,
    pub calculation_method: String,
    pub trend: TrustTrend,
    pub evaluator_id: Uuid,
}

// ============================================================================
// Trust Context
// ============================================================================

/// Time window for evidence consideration.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeWindow {
    pub start: i64,
    pub end: i64,
}

/// Context for trust calculations.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustContext {
    pub evaluator_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub world_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_window: Option<TimeWindow>,
}

// ============================================================================
// Trust Decision
// ============================================================================

/// Result of a trust-based decision.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustDecision {
    pub allowed: bool,
    pub trust_score: f64,
    pub required_score: f64,
    pub dimensions_checked: TrustDimensions,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestions: Option<Vec<String>>,
}

// ============================================================================
// Trust Requirements
// ============================================================================

/// Configuration for trust requirements.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustRequirements {
    pub minimum_trust: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<TrustDimensions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_evidence: Option<Vec<TrustEvidenceType>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_interactions: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_confidence: Option<f64>,
}

// ============================================================================
// Trust Interaction
// ============================================================================

/// Trust interaction to be recorded.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustInteraction {
    pub source_entity_id: Uuid,
    pub target_entity_id: Uuid,
    #[serde(rename = "type")]
    pub interaction_type: TrustEvidenceType,
    pub timestamp: i64,
    pub impact: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<TrustContext>,
}

// ============================================================================
// Trust Calculation Config
// ============================================================================

/// Trust calculation configuration.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustCalculationConfig {
    /// How much recent evidence is weighted vs old (0-1).
    pub recency_bias: f64,
    /// How fast evidence decays over time (points per day).
    pub evidence_decay_rate: f64,
    /// Minimum evidence required for confidence.
    pub minimum_evidence_count: usize,
    /// How much to weight verified vs unverified evidence.
    pub verification_multiplier: f64,
    /// Dimension weights for overall score.
    pub dimension_weights: DimensionWeights,
}

/// Weights for each trust dimension.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionWeights {
    pub reliability: f64,
    pub competence: f64,
    pub integrity: f64,
    pub benevolence: f64,
    pub transparency: f64,
}

impl Default for TrustCalculationConfig {
    fn default() -> Self {
        Self {
            recency_bias: 0.7,
            evidence_decay_rate: 1.0,
            minimum_evidence_count: 3,
            verification_multiplier: 1.5,
            dimension_weights: DimensionWeights {
                reliability: 0.25,
                competence: 0.20,
                integrity: 0.25,
                benevolence: 0.15,
                transparency: 0.15,
            },
        }
    }
}

// ============================================================================
// Security Event (for SecurityModule)
// ============================================================================

/// Security event types.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SecurityEventType {
    LoginAttempt,
    PermissionEscalation,
    SuspiciousCommand,
    RateLimitExceeded,
    AuthenticationFailure,
    UnauthorizedAccess,
    DataExfiltrationAttempt,
}

/// A security event record.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityEvent {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub event_type: SecurityEventType,
    pub entity_id: Uuid,
    pub timestamp: i64,
    pub severity: SecuritySeverity,
    pub description: String,
    pub context: TrustContext,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
}

/// Security event severity levels.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum SecuritySeverity {
    Low,
    Medium,
    High,
    Critical,
}
