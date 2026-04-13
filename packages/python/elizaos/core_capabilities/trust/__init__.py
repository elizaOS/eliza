"""Trust sub-module.

Multi-dimensional trust scoring, evidence-based evaluation, and security
threat detection, ported from plugin-trust TypeScript.
"""

from .actions import (
    evaluate_trust_action,
    record_interaction_action,
    request_elevation_action,
    trust_actions,
    update_role_action,
    update_settings_action,
)
from .evaluators import (
    reflection_evaluator,
    security_evaluator,
    trust_change_evaluator,
    trust_evaluators,
)
from .providers import (
    admin_trust_provider,
    role_provider,
    security_status_provider,
    settings_provider,
    trust_profile_provider,
    trust_providers,
)
from .service import SecurityModuleService, TrustEngineService
from .types import (
    PermissionContext,
    SecurityAction,
    SecurityActionResponse,
    SecurityCheck,
    SecurityCheckType,
    SecurityContext,
    SecurityEvent,
    SecurityEventType,
    SecurityMessage,
    SecuritySeverity,
    ThreatAssessment,
    TrustCalculationConfig,
    TrustContext,
    TrustDecision,
    TrustDimensions,
    TrustEvidence,
    TrustEvidenceType,
    TrustInteraction,
    TrustProfile,
    TrustRequirements,
    TrustTrend,
    TrustTrendDirection,
)

__all__ = [
    # Services
    "TrustEngineService",
    "SecurityModuleService",
    # Actions
    "trust_actions",
    "evaluate_trust_action",
    "record_interaction_action",
    "request_elevation_action",
    "update_role_action",
    "update_settings_action",
    # Providers
    "trust_providers",
    "trust_profile_provider",
    "security_status_provider",
    "admin_trust_provider",
    "role_provider",
    "settings_provider",
    # Evaluators
    "trust_evaluators",
    "security_evaluator",
    "trust_change_evaluator",
    "reflection_evaluator",
    # Types
    "TrustDimensions",
    "TrustEvidenceType",
    "TrustEvidence",
    "TrustProfile",
    "TrustContext",
    "TrustDecision",
    "TrustRequirements",
    "TrustInteraction",
    "TrustCalculationConfig",
    "TrustTrend",
    "TrustTrendDirection",
    "SecurityEventType",
    "SecurityCheckType",
    "SecuritySeverity",
    "SecurityActionResponse",
    "PermissionContext",
    "SecurityContext",
    "SecurityCheck",
    "ThreatAssessment",
    "SecurityEvent",
    "SecurityMessage",
    "SecurityAction",
]
