/**
 * Safety, privacy, freshness, and provenance gate for parenting guidance.
 * Ordinary educational options are returned only after structural risk fields
 * are resolved and the requester may see the record. Sensitive requests stop
 * at a typed human-handoff category whose locale-specific resource is resolved
 * by the host at delivery time.
 */

import { ElizaError } from "@elizaos/core";
import { parentingOptionsFor, parentingSourcesFor } from "./sources.js";
import {
  PARENTING_AGE_BANDS,
  PARENTING_GUIDANCE_VERSION,
  PARENTING_TOPICS,
  type ParentingGuidanceDecision,
  type ParentingGuidanceRequest,
  type ParentingGuidanceStatus,
  type ParentingHandoffKind,
  type ParentingRiskSignal,
} from "./types.js";

const TEEN_PRIVATE_SCOPE = "household.subject.teen_private";

function invalid(message: string, path: string): never {
  throw new ElizaError(message, {
    code: "PARENTING_GUIDANCE_INVALID",
    context: { path },
    severity: "ephemeral",
  });
}

function validateSignal(signal: ParentingRiskSignal, path: string): void {
  if (signal !== "present" && signal !== "absent" && signal !== "unknown") {
    invalid(`${path} is not a valid risk signal`, path);
  }
}

function validateRequest(request: ParentingGuidanceRequest): void {
  if (request.schemaVersion !== PARENTING_GUIDANCE_VERSION) {
    invalid(
      `unsupported parenting guidance version ${request.schemaVersion}`,
      "schemaVersion",
    );
  }
  if (
    request.requestId.trim().length === 0 ||
    !Number.isFinite(Date.parse(request.requestedAt))
  ) {
    invalid(
      "requestId and a valid requestedAt timestamp are required",
      "request",
    );
  }
  if (
    request.subject.entityId.trim().length === 0 ||
    !PARENTING_AGE_BANDS.includes(request.subject.ageBand)
  ) {
    invalid("subject identity and age band are required", "subject");
  }
  if (!PARENTING_TOPICS.includes(request.topic)) {
    invalid("unsupported parenting topic", "topic");
  }
  if (
    request.requester.principalEntityId.trim().length === 0 ||
    request.privacy.subjectEntityId !== request.subject.entityId
  ) {
    invalid(
      "authenticated requester and matching privacy subject are required",
      "privacy",
    );
  }
  if (
    request.safety.classifierId.trim().length === 0 ||
    request.safety.classifierVersion.trim().length === 0 ||
    !Number.isFinite(Date.parse(request.safety.assessedAt))
  ) {
    invalid("a dated structural safety assessment is required", "safety");
  }
  for (const [key, signal] of Object.entries({
    immediateDanger: request.safety.immediateDanger,
    selfHarm: request.safety.selfHarm,
    harmToOthers: request.safety.harmToOthers,
    suspectedAbuseOrNeglect: request.safety.suspectedAbuseOrNeglect,
    medicationOrDiagnosis: request.safety.medicationOrDiagnosis,
    severeOrPersistentSymptoms: request.safety.severeOrPersistentSymptoms,
    legalOrCustodyInterpretation: request.safety.legalOrCustodyInterpretation,
  })) {
    validateSignal(signal, `safety.${key}`);
  }
}

function baseDecision(
  request: ParentingGuidanceRequest,
  status: ParentingGuidanceStatus,
  args: {
    mayDisclosePrivateContext: boolean;
    omissionNotice?: string;
    reasons: readonly string[];
    handoffKinds?: readonly ParentingHandoffKind[];
    urgency?: "immediate" | "prompt" | "routine";
  },
): ParentingGuidanceDecision {
  const handoffKinds = args.handoffKinds ?? [];
  return {
    schemaVersion: PARENTING_GUIDANCE_VERSION,
    requestId: request.requestId,
    status,
    mayProvideEducationalOptions: false,
    mayDisclosePrivateContext: args.mayDisclosePrivateContext,
    omissionNotice: args.omissionNotice ?? null,
    frameworkNotice:
      request.requestedFramework === "good_inside"
        ? "The assistant can cite the named framework's primary source, but does not impersonate its author or claim what that person would say."
        : null,
    sources: [],
    options: [],
    handoff:
      handoffKinds.length === 0
        ? null
        : {
            kinds: [...handoffKinds],
            urgency: args.urgency ?? "prompt",
            requiresLocaleSpecificResourceResolution: true,
            preserveContextForProfessional: args.mayDisclosePrivateContext,
          },
    reasons: [...args.reasons],
    guardrails: [
      "Do not diagnose, recommend medication changes, interpret custody law, or investigate suspected abuse.",
      "Do not promise confidentiality when the host's qualified safety policy requires a limited disclosure.",
      "Resolve crisis, emergency, safeguarding, and professional resources for the person's actual locale at delivery time.",
      "Keep private child context out of shared records unless a verified grant, consent, or qualified safety exception permits it.",
    ],
  };
}

function canReadPrivateContext(request: ParentingGuidanceRequest): boolean {
  if (request.privacy.recordScope === "household_shared") return true;
  if (
    request.requester.principalEntityId === request.subject.entityId &&
    request.requester.role === "subject_child"
  ) {
    return true;
  }
  if (request.privacy.subjectExplicitlyConsentedToRequester) return true;
  if (
    request.privacy.recordScope === "adult_private" &&
    request.requester.role === "owner"
  ) {
    return true;
  }
  return (
    request.privacy.recordScope === "teen_private" &&
    request.requester.grantedScopes.includes(TEEN_PRIVATE_SCOPE)
  );
}

function unknownSafetyFields(request: ParentingGuidanceRequest): string[] {
  return Object.entries({
    immediateDanger: request.safety.immediateDanger,
    selfHarm: request.safety.selfHarm,
    harmToOthers: request.safety.harmToOthers,
    suspectedAbuseOrNeglect: request.safety.suspectedAbuseOrNeglect,
    medicationOrDiagnosis: request.safety.medicationOrDiagnosis,
    severeOrPersistentSymptoms: request.safety.severeOrPersistentSymptoms,
    legalOrCustodyInterpretation: request.safety.legalOrCustodyInterpretation,
  })
    .filter(([, signal]) => signal === "unknown")
    .map(([field]) => field);
}

function expiredSourceIds(
  request: ParentingGuidanceRequest,
  reviewExpiresAt: readonly string[],
): string[] {
  const requestedAt = Date.parse(request.requestedAt);
  return reviewExpiresAt.filter(
    (expiresAt) => Date.parse(expiresAt) < requestedAt,
  );
}

/**
 * Returns educational alternatives or a typed stop/handoff. It never chooses
 * a parenting philosophy, diagnoses a child, or expands a requester's access.
 */
export function evaluateParentingGuidance(
  request: ParentingGuidanceRequest,
): ParentingGuidanceDecision {
  validateRequest(request);
  const privateAccess = canReadPrivateContext(request);

  const urgent = [
    request.safety.immediateDanger,
    request.safety.selfHarm,
    request.safety.harmToOthers,
  ].some((signal) => signal === "present");
  if (urgent) {
    const mayDisclose =
      privateAccess || request.privacy.safetyDisclosureAuthorized;
    return baseDecision(request, "urgent_safety_handoff", {
      mayDisclosePrivateContext: mayDisclose,
      omissionNotice: mayDisclose
        ? undefined
        : "A safety concern exists, but private details are withheld from this requester.",
      reasons: [
        "A structural safety assessment identified immediate danger, self-harm, or possible harm to others.",
        "Ordinary parenting suggestions stop while immediate human safety support is needed.",
      ],
      handoffKinds: ["emergency_services", "crisis_support"],
      urgency: "immediate",
    });
  }

  if (request.safety.suspectedAbuseOrNeglect === "present") {
    const mayDisclose =
      privateAccess || request.privacy.safetyDisclosureAuthorized;
    return baseDecision(request, "safeguarding_handoff", {
      mayDisclosePrivateContext: mayDisclose,
      omissionNotice: mayDisclose
        ? undefined
        : "A safeguarding concern exists, but private details are withheld from this requester.",
      reasons: [
        "A structural safety assessment identified possible abuse or neglect.",
        "The assistant does not investigate, confront an alleged person, or replace a qualified safeguarding response.",
      ],
      handoffKinds: ["child_safeguarding"],
      urgency: "prompt",
    });
  }

  if (
    request.safety.medicationOrDiagnosis === "present" ||
    request.safety.severeOrPersistentSymptoms === "present"
  ) {
    if (!privateAccess) {
      return baseDecision(request, "privacy_withheld", {
        mayDisclosePrivateContext: false,
        omissionNotice:
          "Private child context is not available to this requester. A qualified professional can work directly with the child and authorized caregiver.",
        reasons: [
          "The request involves clinical or severe-symptom context and the requester lacks verified private-scope access.",
        ],
      });
    }
    return baseDecision(request, "professional_handoff", {
      mayDisclosePrivateContext: true,
      reasons: [
        "Medication, diagnosis, or severe or persistent symptoms require an appropriately licensed professional.",
        "The assistant does not infer a diagnosis or recommend starting, stopping, or changing medication.",
      ],
      handoffKinds: [
        "licensed_mental_health_professional",
        "pediatrician_or_prescriber",
      ],
      urgency: "prompt",
    });
  }

  if (request.safety.legalOrCustodyInterpretation === "present") {
    return baseDecision(request, "legal_handoff", {
      mayDisclosePrivateContext: privateAccess,
      omissionNotice: privateAccess
        ? undefined
        : "Private child context is withheld from this requester.",
      reasons: [
        "The request calls for legal or custody-plan interpretation.",
        "The assistant may organize facts but does not adjudicate rights or interpret an order.",
      ],
      handoffKinds: ["qualified_legal_professional"],
      urgency: "routine",
    });
  }

  if (!privateAccess) {
    return baseDecision(request, "privacy_withheld", {
      mayDisclosePrivateContext: false,
      omissionNotice:
        "A private child record exists, but its contents are omitted because this requester lacks verified consent or scope.",
      reasons: [
        "Private child context does not become household-shared merely because the requester is a parent, partner, or caregiver.",
      ],
    });
  }

  const unknown = unknownSafetyFields(request);
  if (unknown.length > 0) {
    return baseDecision(request, "needs_safety_clarification", {
      mayDisclosePrivateContext: true,
      reasons: [
        `Safety assessment is unresolved for: ${unknown.join(", ")}.`,
        "Ordinary guidance waits for structural safety classification rather than assuming risk is absent.",
      ],
    });
  }

  const sources = parentingSourcesFor(
    request.subject.ageBand,
    request.topic,
    request.requestedFramework,
  );
  const expired = expiredSourceIds(
    request,
    sources.map((source) => source.reviewExpiresAt),
  );
  if (expired.length > 0 || sources.length === 0) {
    return baseDecision(request, "professional_handoff", {
      mayDisclosePrivateContext: true,
      reasons: [
        expired.length > 0
          ? "One or more applicable sources are past their required review date."
          : "No reviewed source covers this age band and topic.",
        "The assistant will not fabricate source-grounded advice when the curated basis is unavailable.",
      ],
      handoffKinds: ["licensed_mental_health_professional"],
      urgency: "routine",
    });
  }

  const options = parentingOptionsFor(
    request.subject.ageBand,
    request.topic,
    new Set(sources.map((source) => source.id)),
  );
  if (options.length === 0) {
    return baseDecision(request, "professional_handoff", {
      mayDisclosePrivateContext: true,
      reasons: [
        "Reviewed sources exist, but no vetted educational option maps to this request.",
      ],
      handoffKinds: ["licensed_mental_health_professional"],
      urgency: "routine",
    });
  }

  return {
    schemaVersion: PARENTING_GUIDANCE_VERSION,
    requestId: request.requestId,
    status: "educational_options",
    mayProvideEducationalOptions: true,
    mayDisclosePrivateContext: true,
    omissionNotice: null,
    frameworkNotice:
      request.requestedFramework === "good_inside"
        ? "These options cite the framework's primary source alongside public-health and pediatric sources; the assistant does not impersonate its author or claim a personalized clinical opinion."
        : null,
    sources,
    options,
    handoff: null,
    reasons: [
      "All structural safety fields are resolved as absent.",
      "The authenticated requester may access this record scope.",
      "Applicable sources are within their review window.",
    ],
    guardrails: [
      "Offer these as alternatives for the caregiver to adapt, not a verdict or diagnosis.",
      "Do not use physical punishment, humiliation, threats, or deprivation of a child's basic needs.",
      "Use tentative language about a child's internal state and invite correction.",
      "Escalate for a fresh safety assessment if the situation changes or risk becomes unclear.",
    ],
  };
}
