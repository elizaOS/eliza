/**
 * Contracts for source-grounded parenting decision support. Authenticated
 * identity and safety-classifier results enter as structural fields so private
 * scope, safeguarding, and professional handoff never depend on interpreting
 * user prose or prompt instructions.
 */

export const PARENTING_GUIDANCE_VERSION =
  "parenting-guidance-policy.v1" as const;

export const PARENTING_AGE_BANDS = [
  "toddler_preschool",
  "school_age",
  "teen",
] as const;
export type ParentingAgeBand = (typeof PARENTING_AGE_BANDS)[number];

export const PARENTING_TOPICS = [
  "boundary_setting",
  "routines",
  "communication",
  "emotion_coaching",
  "independence",
  "positive_discipline",
] as const;
export type ParentingTopic = (typeof PARENTING_TOPICS)[number];

export type ParentingRiskSignal = "present" | "absent" | "unknown";

export interface ParentingSafetyAssessment {
  readonly classifierId: string;
  readonly classifierVersion: string;
  readonly assessedAt: string;
  readonly immediateDanger: ParentingRiskSignal;
  readonly selfHarm: ParentingRiskSignal;
  readonly harmToOthers: ParentingRiskSignal;
  readonly suspectedAbuseOrNeglect: ParentingRiskSignal;
  readonly medicationOrDiagnosis: ParentingRiskSignal;
  readonly severeOrPersistentSymptoms: ParentingRiskSignal;
  readonly legalOrCustodyInterpretation: ParentingRiskSignal;
}

export type ParentingRequesterRole =
  | "subject_child"
  | "owner"
  | "co_parent"
  | "partner"
  | "caregiver"
  | "professional";

export interface ParentingRequesterAuthorization {
  readonly principalEntityId: string;
  readonly role: ParentingRequesterRole;
  readonly identityAssurance:
    | "runtime_owner"
    | "connector_verified"
    | "authenticated_entity_session";
  readonly grantedScopes: readonly string[];
}

export interface ParentingPrivacyContext {
  readonly recordScope: "household_shared" | "adult_private" | "teen_private";
  readonly subjectEntityId: string;
  readonly subjectExplicitlyConsentedToRequester: boolean;
  /**
   * This must be set only by the host's safeguarding policy after a qualified
   * safety assessment, never from a model or a requester-provided flag.
   */
  readonly safetyDisclosureAuthorized: boolean;
}

export interface ParentingGuidanceRequest {
  readonly schemaVersion: typeof PARENTING_GUIDANCE_VERSION;
  readonly requestId: string;
  readonly requestedAt: string;
  readonly subject: {
    readonly entityId: string;
    readonly ageBand: ParentingAgeBand;
  };
  readonly topic: ParentingTopic;
  readonly requestedFramework: "none" | "good_inside";
  /**
   * The engine preserves this for a human handoff but never parses it for
   * permissions or risk. Those decisions use the structural fields above.
   */
  readonly untrustedContextSummary: string;
  readonly requester: ParentingRequesterAuthorization;
  readonly privacy: ParentingPrivacyContext;
  readonly safety: ParentingSafetyAssessment;
}

export interface ParentingGuidanceSource {
  readonly id: string;
  readonly publisher: string;
  readonly title: string;
  readonly url: string;
  readonly sourceUpdatedAt: string;
  readonly reviewedAt: string;
  readonly reviewExpiresAt: string;
  readonly evidenceTier:
    | "government_public_health"
    | "professional_academy"
    | "named_framework_primary";
  readonly ageBands: readonly ParentingAgeBand[];
  readonly topics: readonly ParentingTopic[];
}

export interface ParentingGuidanceOption {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly string[];
  readonly sourceIds: readonly string[];
  readonly rationale: string;
}

export type ParentingGuidanceStatus =
  | "educational_options"
  | "privacy_withheld"
  | "needs_safety_clarification"
  | "urgent_safety_handoff"
  | "safeguarding_handoff"
  | "professional_handoff"
  | "legal_handoff";

export type ParentingHandoffKind =
  | "emergency_services"
  | "crisis_support"
  | "child_safeguarding"
  | "licensed_mental_health_professional"
  | "pediatrician_or_prescriber"
  | "qualified_legal_professional";

export interface ParentingGuidanceDecision {
  readonly schemaVersion: typeof PARENTING_GUIDANCE_VERSION;
  readonly requestId: string;
  readonly status: ParentingGuidanceStatus;
  readonly mayProvideEducationalOptions: boolean;
  readonly mayDisclosePrivateContext: boolean;
  readonly omissionNotice: string | null;
  readonly frameworkNotice: string | null;
  readonly sources: readonly ParentingGuidanceSource[];
  readonly options: readonly ParentingGuidanceOption[];
  readonly handoff: {
    readonly kinds: readonly ParentingHandoffKind[];
    readonly urgency: "immediate" | "prompt" | "routine";
    readonly requiresLocaleSpecificResourceResolution: boolean;
    readonly preserveContextForProfessional: boolean;
  } | null;
  readonly reasons: readonly string[];
  readonly guardrails: readonly string[];
}
