/**
 * Structural contracts for family voice intake, co-parent response tracking,
 * and child-safe projections. Text is evidence only: authorization, effects,
 * scheduler behavior, and privacy decisions come from typed fields.
 */
import { createHash } from "node:crypto";
import { ElizaError, stableStringify } from "@elizaos/core";
import type { HouseholdAccessScope } from "../household/types.js";
import type { ParentingGuidanceRequest } from "../parenting/types.js";

export const FAMILY_COMMUNICATIONS_POLICY_VERSION =
  "family-communications.v1" as const;

export const VOICE_INTENT_KINDS = [
  "calendar_lookup",
  "calendar_change",
  "reminder_draft",
  "message_draft",
  "message_send",
  "purchase",
  "private_record_read",
  "household_note",
] as const;
export type VoiceIntentKind = (typeof VOICE_INTENT_KINDS)[number];

export type VoiceIntentEffect =
  | "read"
  | "draft"
  | "external_send"
  | "external_mutation"
  | "purchase"
  | "sensitive_read";

export type VoiceCandidateDecision =
  | "proposed"
  | "requires_explicit_approval"
  | "blocked_scope"
  | "blocked_private_scope";

export interface VoiceSpeakerAttestation {
  readonly schemaVersion: "voice-speaker-attestation.v1";
  readonly attestationId: string;
  readonly issuer: string;
  readonly profileId: string;
  readonly imprintClusterId: string;
  readonly claimedEntityId: string | null;
  readonly bindingRevision: number;
  readonly matchConfidence: number;
  readonly observedAt: string;
  /**
   * Opaque connector proof. The family service never interprets it; the
   * injected voice-profile verifier authenticates it against its own store.
   */
  readonly proof: string;
}

export type UnverifiedVoiceReason =
  | "unknown_profile"
  | "unbound_profile"
  | "invalid_proof"
  | "revoked_binding"
  | "ambiguous_match";

export type VerifiedVoiceSpeaker =
  | {
      readonly kind: "verified";
      readonly entityId: string;
      readonly enrolled: boolean;
      readonly profileBindingVerified: boolean;
      readonly matchConfidence: number;
      readonly bindingRevision: number;
    }
  | {
      readonly kind: "unverified";
      readonly reason: UnverifiedVoiceReason;
    };

export interface VoiceSpeakerVerifier {
  verify(attestation: VoiceSpeakerAttestation): Promise<VerifiedVoiceSpeaker>;
}

export interface VoiceSourceSpanInput {
  readonly start: number;
  readonly end: number;
}

export interface VoiceIntentCandidateInput {
  readonly candidateId: string;
  readonly kind: VoiceIntentKind;
  readonly summary: string;
  readonly subjectEntityIds: readonly string[];
  readonly sourceSpan: VoiceSourceSpanInput;
}

export interface VoiceIntentBundleInput {
  readonly schemaVersion: typeof FAMILY_COMMUNICATIONS_POLICY_VERSION;
  readonly bundleId: string;
  readonly turnId: string;
  readonly capturedAt: string;
  readonly transcript: string;
  readonly claimedPrincipalEntityId: string | null;
  readonly speakerAttestation: VoiceSpeakerAttestation;
  readonly candidates: readonly VoiceIntentCandidateInput[];
}

export interface VoiceSourceSpan {
  readonly start: number;
  readonly end: number;
  readonly textSha256: string;
}

export interface VoiceIntentCandidateRevision {
  readonly candidateId: string;
  readonly bundleId: string;
  readonly version: number;
  readonly kind: VoiceIntentKind;
  readonly effect: VoiceIntentEffect;
  readonly summary: string;
  readonly subjectEntityIds: readonly string[];
  readonly requiredScopes: readonly HouseholdAccessScope[];
  readonly sourceSpan: VoiceSourceSpan;
  readonly decision: VoiceCandidateDecision;
  readonly correctedByEntityId: string | null;
  readonly contentSha256: string;
  readonly createdAt: string;
}

export type VoiceBundleAuthorizationState = "authorized" | "quarantined";

export interface VoiceIntentBundle {
  readonly bundleId: string;
  readonly turnId: string;
  readonly transcriptSha256: string;
  readonly inputSha256: string;
  readonly principalEntityId: string | null;
  readonly authorizationState: VoiceBundleAuthorizationState;
  readonly quarantineReason:
    | UnverifiedVoiceReason
    | "speaker_not_enrolled"
    | "binding_not_verified"
    | "confidence_too_low"
    | "principal_mismatch"
    | null;
  readonly capturedAt: string;
  readonly createdAt: string;
}

export interface VoiceBundleIngestResult {
  readonly replayed: boolean;
  readonly bundle: VoiceIntentBundle;
  readonly candidates: readonly VoiceIntentCandidateRevision[];
}

export interface VoiceCandidateCorrectionInput {
  readonly candidateId: string;
  readonly expectedVersion: number;
  readonly correctedByEntityId: string;
  readonly speakerAttestation: VoiceSpeakerAttestation;
  readonly kind: VoiceIntentKind;
  readonly summary: string;
  readonly subjectEntityIds: readonly string[];
  readonly sourceSpan: VoiceSourceSpanInput;
  /**
   * The corrected transcript is used only to hash the source span. It is not
   * persisted, returned, or interpreted for authorization.
   */
  readonly transcript: string;
}

export const CO_PARENT_RESPONSE_STATES = [
  "accepted",
  "delivered",
  "read",
  "replied",
] as const;
export type CoParentResponseState = (typeof CO_PARENT_RESPONSE_STATES)[number];

export interface CoParentMessageReceipt {
  readonly provider: string;
  readonly providerMessageId: string;
  readonly idempotencyKey: string;
  readonly acceptedAt: string;
}

export interface TrackCoParentMessageInput {
  readonly communicationId: string;
  readonly sentByEntityId: string;
  readonly recipientEntityId: string;
  readonly childSubjectEntityIds: readonly string[];
  readonly threadId: string;
  readonly receipt: CoParentMessageReceipt;
}

export interface CoParentCommunication {
  readonly communicationId: string;
  readonly sentByEntityId: string;
  readonly recipientEntityId: string;
  readonly childSubjectEntityIds: readonly string[];
  readonly threadId: string;
  readonly provider: string;
  readonly providerMessageId: string;
  readonly idempotencyKey: string;
  readonly state: CoParentResponseState;
  readonly acceptedAt: string;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
  readonly repliedAt: string | null;
  readonly slaDueAt: string;
  readonly watcherTaskId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CoParentProviderEventInput {
  readonly provider: string;
  readonly providerEventId: string;
  readonly providerMessageId: string;
  readonly state: CoParentResponseState;
  readonly occurredAt: string;
  readonly actorEntityId: string;
  readonly inReplyToProviderMessageId: string | null;
}

export interface CoParentProviderEvent {
  readonly providerEventId: string;
  readonly provider: string;
  readonly communicationId: string;
  readonly providerMessageId: string;
  readonly state: CoParentResponseState;
  readonly occurredAt: string;
  readonly actorEntityId: string;
  readonly inReplyToProviderMessageId: string | null;
  readonly contentSha256: string;
  readonly createdAt: string;
}

export interface RecordCoParentEventResult {
  readonly inserted: boolean;
  readonly event: CoParentProviderEvent;
  readonly communication: CoParentCommunication;
}

export const FAMILY_WEEK_ITEM_KINDS = [
  "pickup",
  "packing",
  "school_event",
  "child_activity",
  "family_logistics",
  "adult_work",
  "finance",
  "medical",
  "relationship",
  "adult_private",
  "teen_private",
] as const;
export type FamilyWeekItemKind = (typeof FAMILY_WEEK_ITEM_KINDS)[number];

export const FAMILY_WEEK_DATA_CLASSES = [
  "family_logistics",
  "school_shared",
  "packing_shared",
  "adult_work",
  "financial",
  "medical",
  "relationship",
  "adult_private",
  "teen_private",
] as const;
export type FamilyWeekDataClass = (typeof FAMILY_WEEK_DATA_CLASSES)[number];

export interface FamilyWeekItemInput {
  readonly itemId: string;
  readonly kind: FamilyWeekItemKind;
  readonly title: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly location: string | null;
  readonly subjectEntityIds: readonly string[];
  readonly audiencePrincipalEntityIds: readonly string[];
  readonly visibility: "household_shared" | "adult_private" | "teen_private";
  readonly dataClasses: readonly FamilyWeekDataClass[];
  readonly sourceRef: string;
}

export interface ChildWeekItem {
  readonly itemId: string;
  readonly kind: Extract<
    FamilyWeekItemKind,
    | "pickup"
    | "packing"
    | "school_event"
    | "child_activity"
    | "family_logistics"
  >;
  readonly title: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly location: string | null;
  readonly sourceRef: string;
}

export type FamilyWeekOmissionCode =
  | "not_for_child"
  | "principal_not_in_audience"
  | "not_household_shared"
  | "adult_or_private_kind"
  | "sensitive_data_class";

export interface ChildWeekProjection {
  readonly projectionId: string;
  readonly principalEntityId: string;
  readonly childEntityId: string;
  readonly windowStartsAt: string;
  readonly windowEndsAt: string;
  readonly items: readonly ChildWeekItem[];
  readonly omissions: Readonly<Record<FamilyWeekOmissionCode, number>>;
  readonly snapshotSha256: string;
  readonly generatedAt: string;
}

export interface TeenPrivateRecordInput {
  readonly recordId: string;
  readonly subjectEntityId: string;
  readonly summary: string;
  readonly sourceRef: string;
}

export interface TeenPrivateProjection {
  readonly principalEntityId: string;
  readonly subjectEntityId: string;
  readonly records: readonly TeenPrivateRecordInput[];
  readonly omittedCount: number;
  readonly omissionNotice: string | null;
  readonly safeguardingDecision:
    | "not_requested"
    | "withheld"
    | "urgent_safety_handoff"
    | "safeguarding_handoff";
}

export interface ProjectTeenPrivateRecordsInput {
  readonly principalEntityId: string;
  readonly subjectEntityId: string;
  readonly records: readonly TeenPrivateRecordInput[];
  readonly safeguardingRequest?: ParentingGuidanceRequest;
}

export type FamilyCommunicationsErrorCode =
  | "FAMILY_COMMUNICATIONS_ACCESS_DENIED"
  | "FAMILY_COMMUNICATIONS_CONFLICT"
  | "FAMILY_COMMUNICATIONS_ENTITY_NOT_FOUND"
  | "FAMILY_COMMUNICATIONS_INVALID_CONTRACT"
  | "FAMILY_COMMUNICATIONS_PERSISTED_DATA_INVALID"
  | "FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_UNAVAILABLE";

export class FamilyCommunicationsError extends ElizaError {
  override readonly name = "FamilyCommunicationsError";

  constructor(
    message: string,
    code: FamilyCommunicationsErrorCode,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, {
      code,
      context,
      cause,
      severity:
        code === "FAMILY_COMMUNICATIONS_PERSISTED_DATA_INVALID" ||
        code === "FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_UNAVAILABLE"
          ? "fatal"
          : "ephemeral",
    });
  }
}

export function familySha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function requireFamilyText(
  value: unknown,
  field: string,
  maxLength = 2_000,
): string {
  if (typeof value !== "string") {
    throw new FamilyCommunicationsError(
      `${field} must be text`,
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      { field },
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new FamilyCommunicationsError(
      `${field} must contain 1-${maxLength} characters`,
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      { field, length: normalized.length },
    );
  }
  return normalized;
}

export function requireFamilyTimestamp(value: unknown, field: string): string {
  const text = requireFamilyText(value, field, 100);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new FamilyCommunicationsError(
      `${field} must be an ISO-8601 timestamp`,
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      { field },
    );
  }
  return new Date(parsed).toISOString();
}

export function requireFamilyInteger(
  value: unknown,
  field: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new FamilyCommunicationsError(
      `${field} must be an integer greater than or equal to ${minimum}`,
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      { field, value },
    );
  }
  return value as number;
}

export function uniqueFamilyIds(
  values: readonly string[],
  field: string,
): string[] {
  return Array.from(
    new Set(values.map((value) => requireFamilyText(value, field, 200))),
  ).sort();
}

export function voiceIntentPolicy(kind: VoiceIntentKind): {
  effect: VoiceIntentEffect;
  requiredScopes: readonly HouseholdAccessScope[];
  approvalRequired: boolean;
} {
  switch (kind) {
    case "calendar_lookup":
      return {
        effect: "read",
        requiredScopes: ["calendar.freebusy"],
        approvalRequired: false,
      };
    case "calendar_change":
      return {
        effect: "external_mutation",
        requiredScopes: ["calendar.mutate"],
        approvalRequired: true,
      };
    case "message_send":
      return {
        effect: "external_send",
        requiredScopes: ["household.visibility"],
        approvalRequired: true,
      };
    case "purchase":
      return {
        effect: "purchase",
        requiredScopes: ["household.visibility"],
        approvalRequired: true,
      };
    case "private_record_read":
      return {
        effect: "sensitive_read",
        requiredScopes: ["household.visibility"],
        approvalRequired: false,
      };
    case "reminder_draft":
    case "message_draft":
    case "household_note":
      return {
        effect: "draft",
        requiredScopes: ["household.visibility"],
        approvalRequired: false,
      };
  }
}

export function normalizeVoiceBundle(
  input: VoiceIntentBundleInput,
): VoiceIntentBundleInput {
  if (input.schemaVersion !== FAMILY_COMMUNICATIONS_POLICY_VERSION) {
    throw new FamilyCommunicationsError(
      "Unsupported family-communications policy version",
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      { schemaVersion: input.schemaVersion },
    );
  }
  const transcript =
    typeof input.transcript === "string" ? input.transcript.trim() : "";
  if (transcript.length === 0 || transcript.length > 32_768) {
    throw new FamilyCommunicationsError(
      "Voice transcript must contain 1-32768 characters",
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      { length: transcript.length },
    );
  }
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new FamilyCommunicationsError(
      "Voice bundle must contain at least one separated candidate",
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
    );
  }
  const candidateIds = new Set<string>();
  const candidates = input.candidates.map((candidate, index) => {
    const candidateId = requireFamilyText(
      candidate.candidateId,
      `candidates.${index}.candidateId`,
      200,
    );
    if (candidateIds.has(candidateId)) {
      throw new FamilyCommunicationsError(
        "Voice candidate IDs must be unique within a bundle",
        "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
        { candidateId },
      );
    }
    candidateIds.add(candidateId);
    if (!VOICE_INTENT_KINDS.includes(candidate.kind)) {
      throw new FamilyCommunicationsError(
        "Voice candidate kind is unsupported",
        "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
        { candidateId, kind: candidate.kind },
      );
    }
    const start = requireFamilyInteger(
      candidate.sourceSpan.start,
      `candidates.${index}.sourceSpan.start`,
    );
    const end = requireFamilyInteger(
      candidate.sourceSpan.end,
      `candidates.${index}.sourceSpan.end`,
      1,
    );
    if (end <= start || end > transcript.length) {
      throw new FamilyCommunicationsError(
        "Voice candidate source span is outside the transcript",
        "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
        { candidateId, start, end, transcriptLength: transcript.length },
      );
    }
    return {
      candidateId,
      kind: candidate.kind,
      summary: requireFamilyText(
        candidate.summary,
        `candidates.${index}.summary`,
        1_000,
      ),
      subjectEntityIds: uniqueFamilyIds(
        candidate.subjectEntityIds,
        `candidates.${index}.subjectEntityIds`,
      ),
      sourceSpan: { start, end },
    };
  });
  return {
    schemaVersion: FAMILY_COMMUNICATIONS_POLICY_VERSION,
    bundleId: requireFamilyText(input.bundleId, "bundleId", 200),
    turnId: requireFamilyText(input.turnId, "turnId", 200),
    capturedAt: requireFamilyTimestamp(input.capturedAt, "capturedAt"),
    transcript,
    claimedPrincipalEntityId:
      input.claimedPrincipalEntityId === null
        ? null
        : requireFamilyText(
            input.claimedPrincipalEntityId,
            "claimedPrincipalEntityId",
            200,
          ),
    speakerAttestation: normalizeSpeakerAttestation(input.speakerAttestation),
    candidates,
  };
}

export function normalizeSpeakerAttestation(
  input: VoiceSpeakerAttestation,
): VoiceSpeakerAttestation {
  if (input.schemaVersion !== "voice-speaker-attestation.v1") {
    throw new FamilyCommunicationsError(
      "Unsupported voice speaker attestation version",
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
    );
  }
  if (
    typeof input.matchConfidence !== "number" ||
    !Number.isFinite(input.matchConfidence) ||
    input.matchConfidence < 0 ||
    input.matchConfidence > 1
  ) {
    throw new FamilyCommunicationsError(
      "Voice match confidence must be between zero and one",
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
    );
  }
  return {
    schemaVersion: "voice-speaker-attestation.v1",
    attestationId: requireFamilyText(
      input.attestationId,
      "speakerAttestation.attestationId",
      200,
    ),
    issuer: requireFamilyText(input.issuer, "speakerAttestation.issuer", 200),
    profileId: requireFamilyText(
      input.profileId,
      "speakerAttestation.profileId",
      200,
    ),
    imprintClusterId: requireFamilyText(
      input.imprintClusterId,
      "speakerAttestation.imprintClusterId",
      200,
    ),
    claimedEntityId:
      input.claimedEntityId === null
        ? null
        : requireFamilyText(
            input.claimedEntityId,
            "speakerAttestation.claimedEntityId",
            200,
          ),
    bindingRevision: requireFamilyInteger(
      input.bindingRevision,
      "speakerAttestation.bindingRevision",
      1,
    ),
    matchConfidence: input.matchConfidence,
    observedAt: requireFamilyTimestamp(
      input.observedAt,
      "speakerAttestation.observedAt",
    ),
    proof: requireFamilyText(input.proof, "speakerAttestation.proof", 4_096),
  };
}

export function coParentStateRank(state: CoParentResponseState): number {
  return CO_PARENT_RESPONSE_STATES.indexOf(state);
}

export function isCoParentResponseState(
  value: unknown,
): value is CoParentResponseState {
  return (
    typeof value === "string" &&
    CO_PARENT_RESPONSE_STATES.some((state) => state === value)
  );
}

export function isVoiceIntentKind(value: unknown): value is VoiceIntentKind {
  return (
    typeof value === "string" &&
    VOICE_INTENT_KINDS.some((kind) => kind === value)
  );
}
