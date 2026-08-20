/**
 * Dependency-free speaker-name inference shared by meeting capture, voice
 * profiles, transcript transport, and identity binding.
 *
 * The policy folds platform roster, calendar, self-introduction, correction,
 * voice-profile, and recurring-memory evidence into inspectable candidates.
 * It never reports low-confidence attribution as a confirmed identity.
 */

export type SpeakerNameEvidenceSource =
  | "platform_roster"
  | "calendar_attendee"
  | "self_introduction"
  | "user_correction"
  | "voice_profile"
  | "speaker_memory";

export type SpeakerNameResolution =
  | "confirmed"
  | "needs_confirmation"
  | "withheld"
  | "unknown";

export type SpeakerNameBindingAction =
  | "bind_existing_entity"
  | "create_entity"
  | "merge_duplicate_entities"
  | "none";

export type SpeakerNameReasonCode =
  | "borrowed_device_guardrail"
  | "conflicting_name_evidence"
  | "duplicate_entity_merge_required"
  | "high_confidence_name"
  | "low_confidence_name"
  | "no_name_evidence"
  | "recurring_memory_applied"
  | "same_first_name_ambiguity"
  | "sensitive_attribute_guardrail"
  | "source_agreement"
  | "user_correction_applied"
  | "voice_profile_match";

export interface SpeakerNameEvidence {
  source: SpeakerNameEvidenceSource;
  confidence: number;
  name?: string;
  evidenceId?: string;
  entityId?: string;
  profileId?: string;
  observedAt?: string;
  deviceOwnerEntityId?: string;
}

export interface ExistingSpeakerEntity {
  entityId: string;
  displayName: string;
  profileIds?: readonly string[];
  speakerIds?: readonly string[];
}

export interface InferSpeakerNameInput {
  speakerId: string;
  evidence: readonly SpeakerNameEvidence[];
  existingEntities?: readonly ExistingSpeakerEntity[];
  imprintClusterId?: string;
  sensitiveAttributeGuardrail?: boolean;
  minConfirmedConfidence?: number;
}

export interface SpeakerNameProvenance {
  source: SpeakerNameEvidenceSource;
  confidence: number;
  evidenceId?: string;
  entityId?: string;
  profileId?: string;
  observedAt?: string;
}

export interface SpeakerNameCandidate {
  name: string;
  normalizedName: string;
  confidence: number;
  sources: SpeakerNameEvidenceSource[];
  provenance: SpeakerNameProvenance[];
}

export interface SpeakerNameBindingPlan {
  action: SpeakerNameBindingAction;
  displayName?: string;
  entityId?: string;
  profileId?: string;
  mergeEntityIds: string[];
  reasonCodes: SpeakerNameReasonCode[];
}

export interface SpeakerNameVoiceTurnBindingPlan {
  text: string;
  imprintClusterId: string;
  matchConfidence: number;
  matchedEntityId: string | null;
}

export interface SpeakerNameInference {
  speakerId: string;
  resolution: SpeakerNameResolution;
  displayName?: string;
  entityId?: string;
  profileId?: string;
  confidence: number;
  candidateNames: SpeakerNameCandidate[];
  provenance: SpeakerNameProvenance[];
  reasonCodes: SpeakerNameReasonCode[];
  requiresReview: boolean;
  bindingPlan: SpeakerNameBindingPlan;
  voiceTurnBindingPlan?: SpeakerNameVoiceTurnBindingPlan;
}

/** Transport-safe attribution attached to voice turns and transcript spans. */
export interface SpeakerNameAttribution {
  resolution: SpeakerNameResolution;
  displayName?: string;
  confidence: number;
  candidateNames: SpeakerNameCandidate[];
  provenance: SpeakerNameProvenance[];
  reasonCodes: SpeakerNameReasonCode[];
  requiresReview: boolean;
}

/** Drop identity-graph mutation instructions before transporting attribution. */
export function toSpeakerNameAttribution(
  inference: SpeakerNameInference,
): SpeakerNameAttribution {
  return {
    resolution: inference.resolution,
    ...(inference.displayName ? { displayName: inference.displayName } : {}),
    confidence: inference.confidence,
    candidateNames: inference.candidateNames,
    provenance: inference.provenance,
    reasonCodes: inference.reasonCodes,
    requiresReview: inference.requiresReview,
  };
}

interface MutableCandidate extends SpeakerNameCandidate {
  score: number;
}

const DEFAULT_MIN_CONFIRMED_CONFIDENCE = 0.85;
const SOURCE_PRIORITY: Record<SpeakerNameEvidenceSource, number> = {
  user_correction: 1,
  voice_profile: 0.96,
  speaker_memory: 0.94,
  self_introduction: 0.9,
  platform_roster: 0.74,
  calendar_attendee: 0.7,
};

const STRONG_SOURCES = new Set<SpeakerNameEvidenceSource>([
  "user_correction",
  "voice_profile",
  "speaker_memory",
  "self_introduction",
]);

function assertRatio(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `[speaker-name-inference] ${field} must be between 0 and 1`,
    );
  }
}

function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/g, "")
    .toLocaleLowerCase();
}

function displayName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/g, "");
}

function firstName(name: string): string {
  return normalizeName(name).split(" ")[0] ?? "";
}

function uniqueReasonCodes(
  reasonCodes: SpeakerNameReasonCode[],
): SpeakerNameReasonCode[] {
  return [...new Set(reasonCodes)].sort();
}

function groupCandidates(
  evidence: readonly SpeakerNameEvidence[],
): MutableCandidate[] {
  const candidates = new Map<string, MutableCandidate>();
  for (const item of evidence) {
    assertRatio(`${item.source}.confidence`, item.confidence);
    if (!item.name?.trim()) continue;
    const name = displayName(item.name);
    const normalizedName = normalizeName(name);
    if (!normalizedName) continue;
    const existing = candidates.get(normalizedName);
    const candidate =
      existing ??
      ({
        name,
        normalizedName,
        confidence: 0,
        sources: [],
        provenance: [],
        score: 0,
      } satisfies MutableCandidate);
    candidate.confidence = Math.max(candidate.confidence, item.confidence);
    candidate.score = Math.max(
      candidate.score,
      item.confidence * SOURCE_PRIORITY[item.source],
    );
    if (!candidate.sources.includes(item.source)) {
      candidate.sources.push(item.source);
    }
    candidate.provenance.push({
      source: item.source,
      confidence: item.confidence,
      ...(item.evidenceId ? { evidenceId: item.evidenceId } : {}),
      ...(item.entityId ? { entityId: item.entityId } : {}),
      ...(item.profileId ? { profileId: item.profileId } : {}),
      ...(item.observedAt ? { observedAt: item.observedAt } : {}),
    });
    candidates.set(normalizedName, candidate);
  }
  return [...candidates.values()]
    .map((candidate) => ({
      ...candidate,
      sources: [...candidate.sources].sort(),
      provenance: [...candidate.provenance].sort(
        (a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source],
      ),
    }))
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence);
}

function hasSource(
  candidate: SpeakerNameCandidate,
  source: SpeakerNameEvidenceSource,
): boolean {
  return candidate.sources.includes(source);
}

function hasStrongSource(candidate: SpeakerNameCandidate): boolean {
  return candidate.sources.some((source) => STRONG_SOURCES.has(source));
}

function findExistingEntities(
  candidate: SpeakerNameCandidate,
  existingEntities: readonly ExistingSpeakerEntity[],
): ExistingSpeakerEntity[] {
  return existingEntities.filter(
    (entity) => normalizeName(entity.displayName) === candidate.normalizedName,
  );
}

function detectBorrowedDeviceConflict(
  evidence: readonly SpeakerNameEvidence[],
  candidates: readonly SpeakerNameCandidate[],
): boolean {
  const platformNames = new Set(
    evidence
      .filter((item) => item.source === "platform_roster" && item.name)
      .map((item) => normalizeName(item.name ?? "")),
  );
  if (platformNames.size === 0) return false;
  return candidates.some(
    (candidate) =>
      !platformNames.has(candidate.normalizedName) &&
      candidate.confidence >= 0.7 &&
      candidate.sources.some((source) =>
        ["self_introduction", "voice_profile", "user_correction"].includes(
          source,
        ),
      ),
  );
}

function detectSameFirstNameAmbiguity(
  candidates: readonly SpeakerNameCandidate[],
): boolean {
  for (let i = 0; i < candidates.length; i += 1) {
    const left = candidates[i];
    if (!left || left.confidence < 0.6) continue;
    for (let j = i + 1; j < candidates.length; j += 1) {
      const right = candidates[j];
      if (!right || right.confidence < 0.6) continue;
      if (
        left.normalizedName !== right.normalizedName &&
        firstName(left.name) === firstName(right.name)
      ) {
        return true;
      }
    }
  }
  return false;
}

function detectUnresolvedConflict(
  candidates: readonly SpeakerNameCandidate[],
): boolean {
  const [first, second] = candidates;
  if (!first || !second) return false;
  if (hasSource(first, "user_correction")) return false;
  return (
    first.normalizedName !== second.normalizedName &&
    first.confidence >= 0.7 &&
    second.confidence >= 0.7 &&
    Math.abs(first.confidence - second.confidence) < 0.18
  );
}

function buildBindingPlan(
  candidate: SpeakerNameCandidate | null,
  input: InferSpeakerNameInput,
  reasonCodes: SpeakerNameReasonCode[],
): SpeakerNameBindingPlan {
  if (!candidate) {
    return { action: "none", mergeEntityIds: [], reasonCodes: [] };
  }
  const existing = findExistingEntities(
    candidate,
    input.existingEntities ?? [],
  );
  const profileId = candidate.provenance.find(
    (item) => item.profileId,
  )?.profileId;
  const directEntityId = candidate.provenance.find(
    (item) => item.entityId,
  )?.entityId;
  if (existing.length > 1) {
    return {
      action: "merge_duplicate_entities",
      displayName: candidate.name,
      entityId: existing[0]?.entityId,
      ...(profileId ? { profileId } : {}),
      mergeEntityIds: existing.map((entity) => entity.entityId),
      reasonCodes: uniqueReasonCodes([
        ...reasonCodes,
        "duplicate_entity_merge_required",
      ]),
    };
  }
  if (existing.length === 1 || directEntityId) {
    return {
      action: "bind_existing_entity",
      displayName: candidate.name,
      entityId: existing[0]?.entityId ?? directEntityId,
      ...(profileId ? { profileId } : {}),
      mergeEntityIds: [],
      reasonCodes,
    };
  }
  return {
    action: "create_entity",
    displayName: candidate.name,
    ...(profileId ? { profileId } : {}),
    mergeEntityIds: [],
    reasonCodes,
  };
}

export function inferSpeakerName(
  input: InferSpeakerNameInput,
): SpeakerNameInference {
  assertRatio(
    "minConfirmedConfidence",
    input.minConfirmedConfidence ?? DEFAULT_MIN_CONFIRMED_CONFIDENCE,
  );
  const minConfirmedConfidence =
    input.minConfirmedConfidence ?? DEFAULT_MIN_CONFIRMED_CONFIDENCE;
  const candidates = groupCandidates(input.evidence);
  const reasonCodes: SpeakerNameReasonCode[] = [];

  if (candidates.length === 0) {
    reasonCodes.push("no_name_evidence");
    return {
      speakerId: input.speakerId,
      resolution: "unknown",
      confidence: 0,
      candidateNames: [],
      provenance: [],
      reasonCodes,
      requiresReview: true,
      bindingPlan: { action: "none", mergeEntityIds: [], reasonCodes: [] },
    };
  }

  const borrowedDeviceConflict = detectBorrowedDeviceConflict(
    input.evidence,
    candidates,
  );
  if (borrowedDeviceConflict) reasonCodes.push("borrowed_device_guardrail");
  const correction = candidates.find((candidate) =>
    hasSource(candidate, "user_correction"),
  );
  const chosen =
    correction ??
    candidates.find(
      (candidate) =>
        borrowedDeviceConflict && !hasSource(candidate, "platform_roster"),
    ) ??
    candidates[0] ??
    null;

  const sameFirstNameAmbiguity =
    correction === undefined && detectSameFirstNameAmbiguity(candidates);
  const unresolvedConflict =
    correction === undefined &&
    !borrowedDeviceConflict &&
    detectUnresolvedConflict(candidates);
  if (sameFirstNameAmbiguity) reasonCodes.push("same_first_name_ambiguity");
  if (unresolvedConflict) reasonCodes.push("conflicting_name_evidence");
  if (input.sensitiveAttributeGuardrail) {
    reasonCodes.push("sensitive_attribute_guardrail");
  }
  if (chosen?.sources.length && chosen.sources.length > 1) {
    reasonCodes.push("source_agreement");
  }
  if (chosen && hasSource(chosen, "voice_profile")) {
    reasonCodes.push("voice_profile_match");
  }
  if (chosen && hasSource(chosen, "speaker_memory")) {
    reasonCodes.push("recurring_memory_applied");
  }
  if (chosen && hasSource(chosen, "user_correction")) {
    reasonCodes.push("user_correction_applied");
  }

  const canConfirm =
    chosen !== null &&
    chosen.confidence >= minConfirmedConfidence &&
    (hasStrongSource(chosen) || chosen.sources.length > 1) &&
    !sameFirstNameAmbiguity &&
    !unresolvedConflict &&
    (!borrowedDeviceConflict || correction !== undefined) &&
    input.sensitiveAttributeGuardrail !== true;
  if (canConfirm) reasonCodes.push("high_confidence_name");
  if (chosen && !canConfirm) reasonCodes.push("low_confidence_name");

  const resolution: SpeakerNameResolution = input.sensitiveAttributeGuardrail
    ? "withheld"
    : !chosen
      ? "unknown"
      : canConfirm
        ? "confirmed"
        : sameFirstNameAmbiguity || borrowedDeviceConflict
          ? "withheld"
          : "needs_confirmation";
  const confirmed = resolution === "confirmed";
  const bindingPlan = confirmed
    ? buildBindingPlan(chosen, input, uniqueReasonCodes(reasonCodes))
    : { action: "none" as const, mergeEntityIds: [], reasonCodes: [] };
  const uniqueReasons = uniqueReasonCodes(reasonCodes);
  const voiceTurnBindingPlan =
    confirmed &&
    chosen &&
    input.imprintClusterId &&
    (hasSource(chosen, "user_correction") ||
      hasSource(chosen, "speaker_memory"))
      ? {
          text: `This is ${chosen.name}.`,
          imprintClusterId: input.imprintClusterId,
          matchConfidence: chosen.confidence,
          matchedEntityId: bindingPlan.entityId ?? null,
        }
      : undefined;

  return {
    speakerId: input.speakerId,
    resolution,
    ...(confirmed && chosen ? { displayName: chosen.name } : {}),
    ...(confirmed && bindingPlan.entityId
      ? { entityId: bindingPlan.entityId }
      : {}),
    ...(confirmed && bindingPlan.profileId
      ? { profileId: bindingPlan.profileId }
      : {}),
    confidence: chosen?.confidence ?? 0,
    candidateNames: candidates.map(
      ({ score: _score, ...candidate }) => candidate,
    ),
    provenance: chosen?.provenance ?? [],
    reasonCodes: uniqueReasons,
    requiresReview:
      !confirmed || bindingPlan.action === "merge_duplicate_entities",
    bindingPlan,
    ...(voiceTurnBindingPlan ? { voiceTurnBindingPlan } : {}),
  };
}
