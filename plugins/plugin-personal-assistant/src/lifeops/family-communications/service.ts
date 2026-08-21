/**
 * Family-communications policy over the canonical household graph, a verified
 * voice-profile boundary, durable evidence, and the shared ScheduledTask
 * runner. The service creates proposals and owner-only SLA notices; it never
 * sends a message, mutates a calendar, purchases, or replies automatically.
 */
import {
  type EntityStore,
  KNOWLEDGE_GRAPH_SERVICE,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import { type IAgentRuntime, Service } from "@elizaos/core";
import {
  type ScheduledTask,
  type ScheduledTaskRunnerHandle,
  waitForScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import {
  createHouseholdCoordinationService,
  getHouseholdCoordinationService,
  HOUSEHOLD_COORDINATION_SERVICE,
  type HouseholdCoordinationService,
} from "../household/service.js";
import { HouseholdCoordinationError } from "../household/types.js";
import { evaluateParentingGuidance } from "../parenting/policy.js";
import { getScheduledTaskRunner } from "../scheduled-task/service.js";
import {
  FamilyCommunicationsRepository,
  newFamilyProjectionId,
} from "./repository.js";
import {
  type ChildWeekItem,
  type ChildWeekProjection,
  type CoParentCommunication,
  type CoParentProviderEventInput,
  FamilyCommunicationsError,
  type FamilyWeekDataClass,
  type FamilyWeekItemInput,
  type FamilyWeekOmissionCode,
  familySha256,
  isCoParentResponseState,
  normalizeSpeakerAttestation,
  normalizeVoiceBundle,
  type ProjectTeenPrivateRecordsInput,
  type RecordCoParentEventResult,
  requireFamilyInteger,
  requireFamilyText,
  requireFamilyTimestamp,
  type TeenPrivateProjection,
  type TrackCoParentMessageInput,
  uniqueFamilyIds,
  type VerifiedVoiceSpeaker,
  type VoiceBundleIngestResult,
  type VoiceCandidateCorrectionInput,
  type VoiceCandidateDecision,
  type VoiceIntentBundle,
  type VoiceIntentBundleInput,
  type VoiceIntentCandidateInput,
  type VoiceIntentCandidateRevision,
  type VoiceSpeakerAttestation,
  type VoiceSpeakerVerifier,
  voiceIntentPolicy,
} from "./types.js";

export const FAMILY_COMMUNICATIONS_SERVICE = "lifeops_family_communications";
export const FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_SERVICE =
  "lifeops_family_voice_speaker_verifier";
export const FAMILY_COMMUNICATIONS_MIN_SPEAKER_CONFIDENCE = 0.82;
export const CO_PARENT_RESPONSE_SLA_HOURS = 24;
const MAX_ATTESTATION_SKEW_MS = 2 * 60 * 1000;
const SENSITIVE_WEEK_DATA_CLASSES: ReadonlySet<FamilyWeekDataClass> = new Set([
  "adult_work",
  "financial",
  "medical",
  "relationship",
  "adult_private",
  "teen_private",
]);
const SAFE_WEEK_DATA_CLASSES: ReadonlySet<FamilyWeekDataClass> = new Set([
  "family_logistics",
  "school_shared",
  "packing_shared",
]);
const SAFE_WEEK_KINDS = new Set([
  "pickup",
  "packing",
  "school_event",
  "child_activity",
  "family_logistics",
]);
const EXPECTED_SCOPE_DENIAL_CODES = new Set([
  "HOUSEHOLD_ACCESS_DENIED",
  "HOUSEHOLD_GRANT_EXPIRED",
  "HOUSEHOLD_GRANT_REVOKED",
]);

export interface FamilyCommunicationsDependencies {
  readonly runtime: IAgentRuntime;
  readonly agentId: string;
  readonly entityStore: EntityStore;
  readonly household: HouseholdCoordinationService;
  readonly repository: FamilyCommunicationsRepository;
  readonly speakerVerifier: VoiceSpeakerVerifier;
  readonly scheduledTasks: ScheduledTaskRunnerHandle;
  readonly now?: () => Date;
}

export abstract class FamilyVoiceSpeakerVerifierRuntimeService
  extends Service
  implements VoiceSpeakerVerifier
{
  static override serviceType = FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_SERVICE;

  override capabilityDescription =
    "Authenticates voice-profile bindings for family authorization";

  abstract verify(
    attestation: VoiceSpeakerAttestation,
  ): Promise<VerifiedVoiceSpeaker>;

  async stop(): Promise<void> {}
}

function quarantinedBundle(
  input: VoiceIntentBundleInput,
  inputSha256: string,
  createdAt: string,
  reason: NonNullable<VoiceIntentBundle["quarantineReason"]>,
): VoiceIntentBundle {
  return {
    bundleId: input.bundleId,
    turnId: input.turnId,
    transcriptSha256: familySha256(input.transcript),
    inputSha256,
    principalEntityId: null,
    authorizationState: "quarantined",
    quarantineReason: reason,
    capturedAt: input.capturedAt,
    createdAt,
  };
}

function voiceBundleInputSha256(input: VoiceIntentBundleInput): string {
  const {
    attestationId: _attestationId,
    proof: _proof,
    ...speakerBinding
  } = input.speakerAttestation;
  return familySha256({
    ...input,
    speakerAttestation: speakerBinding,
  });
}

function voiceSourceSpan(
  transcript: string,
  input: VoiceIntentCandidateInput["sourceSpan"],
): VoiceIntentCandidateRevision["sourceSpan"] {
  return {
    start: input.start,
    end: input.end,
    textSha256: familySha256(transcript.slice(input.start, input.end)),
  };
}

function voiceRevisionContent(
  revision: Omit<VoiceIntentCandidateRevision, "contentSha256">,
): VoiceIntentCandidateRevision {
  return { ...revision, contentSha256: familySha256(revision) };
}

function normalizeProviderEvent(
  input: CoParentProviderEventInput,
): CoParentProviderEventInput {
  if (!isCoParentResponseState(input.state)) {
    throw new FamilyCommunicationsError(
      "Provider event state is unsupported",
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      { state: input.state },
    );
  }
  return {
    provider: requireFamilyText(input.provider, "provider", 200),
    providerEventId: requireFamilyText(
      input.providerEventId,
      "providerEventId",
      300,
    ),
    providerMessageId: requireFamilyText(
      input.providerMessageId,
      "providerMessageId",
      300,
    ),
    state: input.state,
    occurredAt: requireFamilyTimestamp(input.occurredAt, "occurredAt"),
    actorEntityId: requireFamilyText(input.actorEntityId, "actorEntityId", 200),
    inReplyToProviderMessageId:
      input.inReplyToProviderMessageId === null
        ? null
        : requireFamilyText(
            input.inReplyToProviderMessageId,
            "inReplyToProviderMessageId",
            300,
          ),
  };
}

export class FamilyCommunicationsService {
  private readonly now: () => Date;

  constructor(private readonly deps: FamilyCommunicationsDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await this.deps.repository.ensureSchema();
    await this.recoverPendingResponseWatchers();
  }

  private async assertCanonicalEntity(entityId: string): Promise<void> {
    if (!(await this.deps.entityStore.get(entityId))) {
      throw new FamilyCommunicationsError(
        `Entity ${entityId} is not present in the canonical EntityStore`,
        "FAMILY_COMMUNICATIONS_ENTITY_NOT_FOUND",
        { entityId },
      );
    }
  }

  private async verifySpeaker(
    attestationInput: VoiceSpeakerAttestation,
    capturedAt: string,
  ): Promise<VerifiedVoiceSpeaker> {
    const attestation = normalizeSpeakerAttestation(attestationInput);
    if (
      Math.abs(Date.parse(attestation.observedAt) - Date.parse(capturedAt)) >
      MAX_ATTESTATION_SKEW_MS
    ) {
      return { kind: "unverified", reason: "invalid_proof" };
    }
    const verified = await this.deps.speakerVerifier.verify(attestation);
    if (
      verified.kind === "verified" &&
      (attestation.claimedEntityId !== verified.entityId ||
        attestation.bindingRevision !== verified.bindingRevision ||
        attestation.matchConfidence !== verified.matchConfidence)
    ) {
      return { kind: "unverified", reason: "invalid_proof" };
    }
    return verified;
  }

  private async decisionForCandidate(
    principalEntityId: string,
    candidate: Pick<VoiceIntentCandidateInput, "kind" | "subjectEntityIds">,
  ): Promise<{
    decision: VoiceCandidateDecision;
    policy: ReturnType<typeof voiceIntentPolicy>;
  }> {
    const policy = voiceIntentPolicy(candidate.kind);
    if (
      (candidate.kind === "private_record_read" ||
        candidate.kind === "purchase") &&
      principalEntityId !== SELF_ENTITY_ID
    ) {
      return {
        decision:
          candidate.kind === "private_record_read"
            ? "blocked_private_scope"
            : "blocked_scope",
        policy,
      };
    }
    const subjects =
      candidate.subjectEntityIds.length > 0
        ? candidate.subjectEntityIds
        : [undefined];
    try {
      for (const scope of policy.requiredScopes) {
        for (const subjectEntityId of subjects) {
          await this.deps.household.requireScope({
            principalEntityId,
            scope,
            ...(subjectEntityId === undefined ? {} : { subjectEntityId }),
          });
        }
      }
    } catch (error) {
      // error-policy:J4 A revoked, expired, or absent household grant maps to
      // an explicit blocked candidate; invariant and storage failures surface.
      if (
        error instanceof HouseholdCoordinationError &&
        EXPECTED_SCOPE_DENIAL_CODES.has(error.code)
      ) {
        return { decision: "blocked_scope", policy };
      }
      throw error;
    }
    return {
      decision: policy.approvalRequired
        ? "requires_explicit_approval"
        : "proposed",
      policy,
    };
  }

  async ingestVoiceBundle(
    inputValue: VoiceIntentBundleInput,
  ): Promise<VoiceBundleIngestResult> {
    const input = normalizeVoiceBundle(inputValue);
    // Authentication tokens are deliberately short-lived. Idempotency binds
    // the enduring request semantics, while every authorized replay still
    // presents and verifies a fresh token below.
    const inputSha256 = voiceBundleInputSha256(input);
    const existing = await this.deps.repository.getBundleByTurn(input.turnId);
    if (existing) {
      if (
        existing.bundle.inputSha256 !== inputSha256 ||
        existing.bundle.bundleId !== input.bundleId
      ) {
        throw new FamilyCommunicationsError(
          "Voice turn replay carries different bytes",
          "FAMILY_COMMUNICATIONS_CONFLICT",
          { turnId: input.turnId },
        );
      }
      if (existing.bundle.authorizationState === "authorized") {
        const replaySpeaker = await this.verifySpeaker(
          input.speakerAttestation,
          input.capturedAt,
        );
        if (
          replaySpeaker.kind !== "verified" ||
          !replaySpeaker.enrolled ||
          !replaySpeaker.profileBindingVerified ||
          replaySpeaker.matchConfidence <
            FAMILY_COMMUNICATIONS_MIN_SPEAKER_CONFIDENCE ||
          replaySpeaker.entityId !== existing.bundle.principalEntityId
        ) {
          throw new FamilyCommunicationsError(
            "Authorized voice replay requires a fresh exact speaker verification",
            "FAMILY_COMMUNICATIONS_ACCESS_DENIED",
            { turnId: input.turnId },
          );
        }
      }
      return existing;
    }
    const createdAt = this.now().toISOString();
    const verified = await this.verifySpeaker(
      input.speakerAttestation,
      input.capturedAt,
    );
    if (verified.kind === "unverified") {
      return this.deps.repository.insertVoiceBundle(
        quarantinedBundle(input, inputSha256, createdAt, verified.reason),
        [],
      );
    }
    const quarantineReason = !verified.profileBindingVerified
      ? "binding_not_verified"
      : !verified.enrolled
        ? "speaker_not_enrolled"
        : verified.matchConfidence <
            FAMILY_COMMUNICATIONS_MIN_SPEAKER_CONFIDENCE
          ? "confidence_too_low"
          : input.claimedPrincipalEntityId !== null &&
              input.claimedPrincipalEntityId !== verified.entityId
            ? "principal_mismatch"
            : null;
    if (quarantineReason) {
      return this.deps.repository.insertVoiceBundle(
        quarantinedBundle(input, inputSha256, createdAt, quarantineReason),
        [],
      );
    }
    await this.assertCanonicalEntity(verified.entityId);
    const candidates: VoiceIntentCandidateRevision[] = [];
    for (const candidate of input.candidates) {
      for (const subjectEntityId of candidate.subjectEntityIds) {
        await this.assertCanonicalEntity(subjectEntityId);
      }
      const { decision, policy } = await this.decisionForCandidate(
        verified.entityId,
        candidate,
      );
      const revision = voiceRevisionContent({
        candidateId: candidate.candidateId,
        bundleId: input.bundleId,
        version: 1,
        kind: candidate.kind,
        effect: policy.effect,
        summary: candidate.summary,
        subjectEntityIds: candidate.subjectEntityIds,
        requiredScopes: policy.requiredScopes,
        sourceSpan: voiceSourceSpan(input.transcript, candidate.sourceSpan),
        decision,
        correctedByEntityId: null,
        createdAt,
      });
      candidates.push(revision);
    }
    const bundle: VoiceIntentBundle = {
      bundleId: input.bundleId,
      turnId: input.turnId,
      transcriptSha256: familySha256(input.transcript),
      inputSha256,
      principalEntityId: verified.entityId,
      authorizationState: "authorized",
      quarantineReason: null,
      capturedAt: input.capturedAt,
      createdAt,
    };
    return this.deps.repository.insertVoiceBundle(bundle, candidates);
  }

  async correctVoiceCandidate(
    input: VoiceCandidateCorrectionInput,
  ): Promise<VoiceIntentCandidateRevision> {
    const candidateId = requireFamilyText(
      input.candidateId,
      "candidateId",
      200,
    );
    const expectedVersion = requireFamilyInteger(
      input.expectedVersion,
      "expectedVersion",
      1,
    );
    const current = await this.deps.repository.getCurrentCandidate(candidateId);
    if (!current) {
      throw new FamilyCommunicationsError(
        "Voice candidate does not exist",
        "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
        { candidateId },
      );
    }
    const bundle = await this.deps.repository.getBundle(current.bundleId);
    if (
      bundle?.authorizationState !== "authorized" ||
      bundle.principalEntityId === null
    ) {
      throw new FamilyCommunicationsError(
        "Voice candidate has no authorized source bundle",
        "FAMILY_COMMUNICATIONS_PERSISTED_DATA_INVALID",
        { candidateId, bundleId: current.bundleId },
      );
    }
    const correctedByEntityId = requireFamilyText(
      input.correctedByEntityId,
      "correctedByEntityId",
      200,
    );
    const verified = await this.verifySpeaker(
      input.speakerAttestation,
      this.now().toISOString(),
    );
    if (
      verified.kind !== "verified" ||
      !verified.enrolled ||
      !verified.profileBindingVerified ||
      verified.matchConfidence < FAMILY_COMMUNICATIONS_MIN_SPEAKER_CONFIDENCE ||
      verified.entityId !== correctedByEntityId ||
      (correctedByEntityId !== SELF_ENTITY_ID &&
        correctedByEntityId !== bundle.principalEntityId)
    ) {
      throw new FamilyCommunicationsError(
        "Candidate correction requires the exact verified source speaker or owner",
        "FAMILY_COMMUNICATIONS_ACCESS_DENIED",
        { candidateId, correctedByEntityId },
      );
    }
    const transcript =
      typeof input.transcript === "string" ? input.transcript.trim() : "";
    if (familySha256(transcript) !== bundle.transcriptSha256) {
      throw new FamilyCommunicationsError(
        "Candidate correction transcript does not match the source turn",
        "FAMILY_COMMUNICATIONS_CONFLICT",
        { candidateId },
      );
    }
    const normalized = normalizeVoiceBundle({
      schemaVersion: "family-communications.v1",
      bundleId: bundle.bundleId,
      turnId: bundle.turnId,
      capturedAt: bundle.capturedAt,
      transcript,
      claimedPrincipalEntityId: bundle.principalEntityId,
      speakerAttestation: input.speakerAttestation,
      candidates: [
        {
          candidateId,
          kind: input.kind,
          summary: input.summary,
          subjectEntityIds: input.subjectEntityIds,
          sourceSpan: input.sourceSpan,
        },
      ],
    }).candidates[0];
    if (!normalized) {
      throw new FamilyCommunicationsError(
        "Candidate correction could not be normalized",
        "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
        { candidateId },
      );
    }
    for (const subjectEntityId of normalized.subjectEntityIds) {
      await this.assertCanonicalEntity(subjectEntityId);
    }
    const { decision, policy } = await this.decisionForCandidate(
      bundle.principalEntityId,
      normalized,
    );
    const createdAt = this.now().toISOString();
    const revision = voiceRevisionContent({
      candidateId,
      bundleId: bundle.bundleId,
      version: expectedVersion + 1,
      kind: normalized.kind,
      effect: policy.effect,
      summary: normalized.summary,
      subjectEntityIds: normalized.subjectEntityIds,
      requiredScopes: policy.requiredScopes,
      sourceSpan: voiceSourceSpan(transcript, normalized.sourceSpan),
      decision,
      correctedByEntityId,
      createdAt,
    });
    return this.deps.repository.appendCandidateCorrection(
      revision,
      expectedVersion,
    );
  }

  private responseWatcherInput(
    communication: CoParentCommunication,
  ): Parameters<ScheduledTaskRunnerHandle["schedule"]>[0] {
    return {
      kind: "watcher",
      promptInstructions:
        "A tracked co-parent response window has ended. Show the owner one factual in-app status card using the structured communication metadata. Do not message the co-parent and do not create a reply.",
      trigger: { kind: "once", atIso: communication.slaDueAt },
      priority: "medium",
      output: {
        destination: "in_app_card",
        target: `entity:${SELF_ENTITY_ID}`,
      },
      subject: { kind: "thread", id: communication.threadId },
      idempotencyKey: `family-communications:coparent-sla:${communication.communicationId}`,
      respectsGlobalPause: true,
      source: "plugin",
      createdBy: this.deps.agentId,
      ownerVisible: true,
      metadata: {
        familyCommunicationsKind: "co_parent_response_sla",
        communicationId: communication.communicationId,
        recipientEntityId: communication.recipientEntityId,
        childSubjectEntityIds: communication.childSubjectEntityIds,
        responseState: communication.state,
        noAutoReply: true,
        ownerOnly: true,
      },
    };
  }

  private async ensureResponseWatcher(
    communication: CoParentCommunication,
  ): Promise<CoParentCommunication> {
    if (communication.state === "replied") return communication;
    const task = await this.deps.scheduledTasks.schedule(
      this.responseWatcherInput(communication),
    );
    return this.deps.repository.attachWatcher(
      communication.communicationId,
      task.taskId,
      this.now().toISOString(),
    );
  }

  async recoverPendingResponseWatchers(): Promise<CoParentCommunication[]> {
    const pending =
      await this.deps.repository.listCommunicationsMissingWatchers();
    const recovered: CoParentCommunication[] = [];
    for (const communication of pending) {
      recovered.push(await this.ensureResponseWatcher(communication));
    }
    return recovered;
  }

  async trackCoParentMessage(
    inputValue: TrackCoParentMessageInput,
  ): Promise<CoParentCommunication> {
    const input: TrackCoParentMessageInput = {
      communicationId: requireFamilyText(
        inputValue.communicationId,
        "communicationId",
        200,
      ),
      sentByEntityId: requireFamilyText(
        inputValue.sentByEntityId,
        "sentByEntityId",
        200,
      ),
      recipientEntityId: requireFamilyText(
        inputValue.recipientEntityId,
        "recipientEntityId",
        200,
      ),
      childSubjectEntityIds: uniqueFamilyIds(
        inputValue.childSubjectEntityIds,
        "childSubjectEntityIds",
      ),
      threadId: requireFamilyText(inputValue.threadId, "threadId", 300),
      receipt: {
        provider: requireFamilyText(
          inputValue.receipt.provider,
          "receipt.provider",
          200,
        ),
        providerMessageId: requireFamilyText(
          inputValue.receipt.providerMessageId,
          "receipt.providerMessageId",
          300,
        ),
        idempotencyKey: requireFamilyText(
          inputValue.receipt.idempotencyKey,
          "receipt.idempotencyKey",
          300,
        ),
        acceptedAt: requireFamilyTimestamp(
          inputValue.receipt.acceptedAt,
          "receipt.acceptedAt",
        ),
      },
    };
    if (input.sentByEntityId !== SELF_ENTITY_ID) {
      throw new FamilyCommunicationsError(
        "Only the authenticated owner may register an outbound co-parent SLA",
        "FAMILY_COMMUNICATIONS_ACCESS_DENIED",
        { sentByEntityId: input.sentByEntityId },
      );
    }
    if (input.childSubjectEntityIds.length === 0) {
      throw new FamilyCommunicationsError(
        "Co-parent response tracking requires exact child subjects",
        "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      );
    }
    await this.assertCanonicalEntity(SELF_ENTITY_ID);
    await this.assertCanonicalEntity(input.recipientEntityId);
    for (const childEntityId of input.childSubjectEntityIds) {
      await this.assertCanonicalEntity(childEntityId);
    }
    const recipientBinding = (
      await this.deps.household.listRoleBindings()
    ).find(
      (binding) =>
        binding.entityId === input.recipientEntityId &&
        binding.role === "co_parent",
    );
    if (
      !recipientBinding ||
      input.childSubjectEntityIds.some(
        (childEntityId) =>
          !recipientBinding.subjectEntityIds.includes(childEntityId),
      )
    ) {
      throw new FamilyCommunicationsError(
        "Response tracking requires an active co-parent relationship to every named child",
        "FAMILY_COMMUNICATIONS_ACCESS_DENIED",
        {
          recipientEntityId: input.recipientEntityId,
          childSubjectEntityIds: input.childSubjectEntityIds,
        },
      );
    }
    const acceptedMs = Date.parse(input.receipt.acceptedAt);
    if (acceptedMs > this.now().getTime() + 5 * 60 * 1000) {
      throw new FamilyCommunicationsError(
        "Co-parent provider receipt is dated in the future",
        "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
        { acceptedAt: input.receipt.acceptedAt },
      );
    }
    const slaDueAt = new Date(
      acceptedMs + CO_PARENT_RESPONSE_SLA_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const persisted = await this.deps.repository.insertCommunication(
      input,
      slaDueAt,
      this.now().toISOString(),
    );
    return this.ensureResponseWatcher(persisted);
  }

  private async completeResponseWatcher(
    communication: CoParentCommunication,
  ): Promise<void> {
    if (!communication.watcherTaskId) return;
    const tasks = await this.deps.scheduledTasks.list();
    const watcher = tasks.find(
      (task) => task.taskId === communication.watcherTaskId,
    );
    if (!watcher) {
      throw new FamilyCommunicationsError(
        "Tracked co-parent response watcher is missing",
        "FAMILY_COMMUNICATIONS_PERSISTED_DATA_INVALID",
        {
          communicationId: communication.communicationId,
          watcherTaskId: communication.watcherTaskId,
        },
      );
    }
    if (watcher.state.status === "completed") return;
    if (
      watcher.state.status !== "scheduled" &&
      watcher.state.status !== "fired" &&
      watcher.state.status !== "acknowledged"
    ) {
      throw new FamilyCommunicationsError(
        "Co-parent response watcher is in an incompatible terminal state",
        "FAMILY_COMMUNICATIONS_CONFLICT",
        {
          communicationId: communication.communicationId,
          watcherTaskId: watcher.taskId,
          status: watcher.state.status,
        },
      );
    }
    await this.deps.scheduledTasks.apply(watcher.taskId, "complete", {
      reason: "exact_recipient_reply_observed",
    });
  }

  private async refreshResponseWatcher(
    communication: CoParentCommunication,
  ): Promise<void> {
    if (!communication.watcherTaskId) {
      throw new FamilyCommunicationsError(
        "Tracked co-parent communication has no SLA watcher",
        "FAMILY_COMMUNICATIONS_PERSISTED_DATA_INVALID",
        { communicationId: communication.communicationId },
      );
    }
    const watcher = (await this.deps.scheduledTasks.list()).find(
      (task) => task.taskId === communication.watcherTaskId,
    );
    if (!watcher) {
      throw new FamilyCommunicationsError(
        "Tracked co-parent response watcher is missing",
        "FAMILY_COMMUNICATIONS_PERSISTED_DATA_INVALID",
        {
          communicationId: communication.communicationId,
          watcherTaskId: communication.watcherTaskId,
        },
      );
    }
    const metadata = {
      ...watcher.metadata,
      responseState: communication.state,
      deliveredAt: communication.deliveredAt,
      readAt: communication.readAt,
      repliedAt: communication.repliedAt,
    };
    if (familySha256(metadata) === familySha256(watcher.metadata)) return;
    await this.deps.scheduledTasks.apply(watcher.taskId, "edit", { metadata });
  }

  async recordCoParentProviderEvent(
    inputValue: CoParentProviderEventInput,
  ): Promise<RecordCoParentEventResult> {
    const input = normalizeProviderEvent(inputValue);
    const result = await this.deps.repository.recordProviderEvent(
      input,
      this.now().toISOString(),
    );
    if (result.communication.state === "replied") {
      await this.completeResponseWatcher(result.communication);
    } else {
      await this.refreshResponseWatcher(result.communication);
    }
    return result;
  }

  async projectChildWeek(input: {
    principalEntityId: string;
    childEntityId: string;
    windowStartsAt: string;
    windowEndsAt: string;
    items: readonly FamilyWeekItemInput[];
  }): Promise<ChildWeekProjection> {
    const principalEntityId = requireFamilyText(
      input.principalEntityId,
      "principalEntityId",
      200,
    );
    const childEntityId = requireFamilyText(
      input.childEntityId,
      "childEntityId",
      200,
    );
    if (principalEntityId !== childEntityId) {
      throw new FamilyCommunicationsError(
        "A child-week view may only be projected for the authenticated child principal",
        "FAMILY_COMMUNICATIONS_ACCESS_DENIED",
        { principalEntityId, childEntityId },
      );
    }
    await this.assertCanonicalEntity(childEntityId);
    const childBinding = (await this.deps.household.listRoleBindings()).find(
      (binding) =>
        binding.entityId === childEntityId && binding.role === "child",
    );
    if (!childBinding) {
      throw new FamilyCommunicationsError(
        "Child-week view requires an active child household role",
        "FAMILY_COMMUNICATIONS_ACCESS_DENIED",
        { childEntityId },
      );
    }
    await this.deps.household.requireScope({
      principalEntityId,
      scope: "household.visibility",
      subjectEntityId: childEntityId,
    });
    const windowStartsAt = requireFamilyTimestamp(
      input.windowStartsAt,
      "windowStartsAt",
    );
    const windowEndsAt = requireFamilyTimestamp(
      input.windowEndsAt,
      "windowEndsAt",
    );
    if (Date.parse(windowEndsAt) <= Date.parse(windowStartsAt)) {
      throw new FamilyCommunicationsError(
        "Child-week window must end after it starts",
        "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      );
    }
    const omissions: Record<FamilyWeekOmissionCode, number> = {
      not_for_child: 0,
      principal_not_in_audience: 0,
      not_household_shared: 0,
      adult_or_private_kind: 0,
      sensitive_data_class: 0,
    };
    const items: ChildWeekItem[] = [];
    for (const item of input.items) {
      if (!item.subjectEntityIds.includes(childEntityId)) {
        omissions.not_for_child += 1;
        continue;
      }
      if (!item.audiencePrincipalEntityIds.includes(principalEntityId)) {
        omissions.principal_not_in_audience += 1;
        continue;
      }
      if (item.visibility !== "household_shared") {
        omissions.not_household_shared += 1;
        continue;
      }
      if (!SAFE_WEEK_KINDS.has(item.kind)) {
        omissions.adult_or_private_kind += 1;
        continue;
      }
      if (
        item.dataClasses.length === 0 ||
        item.dataClasses.some(
          (dataClass) =>
            SENSITIVE_WEEK_DATA_CLASSES.has(dataClass) ||
            !SAFE_WEEK_DATA_CLASSES.has(dataClass),
        )
      ) {
        omissions.sensitive_data_class += 1;
        continue;
      }
      const startsAt =
        item.startsAt === null
          ? null
          : requireFamilyTimestamp(item.startsAt, "item.startsAt");
      const endsAt =
        item.endsAt === null
          ? null
          : requireFamilyTimestamp(item.endsAt, "item.endsAt");
      if (
        (startsAt && Date.parse(startsAt) >= Date.parse(windowEndsAt)) ||
        (endsAt && Date.parse(endsAt) <= Date.parse(windowStartsAt))
      ) {
        continue;
      }
      items.push({
        itemId: requireFamilyText(item.itemId, "item.itemId", 200),
        kind: item.kind as ChildWeekItem["kind"],
        title: requireFamilyText(item.title, "item.title", 1_000),
        startsAt,
        endsAt,
        location:
          item.location === null
            ? null
            : requireFamilyText(item.location, "item.location", 500),
        sourceRef: requireFamilyText(item.sourceRef, "item.sourceRef", 500),
      });
    }
    items.sort((left, right) =>
      (left.startsAt ?? "").localeCompare(right.startsAt ?? ""),
    );
    const generatedAt = this.now().toISOString();
    const projectionContent = {
      principalEntityId,
      childEntityId,
      windowStartsAt,
      windowEndsAt,
      items,
      omissions,
    };
    const projection: ChildWeekProjection = {
      projectionId: newFamilyProjectionId(),
      ...projectionContent,
      snapshotSha256: familySha256(projectionContent),
      generatedAt,
    };
    return this.deps.repository.saveChildWeekProjection(projection);
  }

  async projectTeenPrivateRecords(
    input: ProjectTeenPrivateRecordsInput,
  ): Promise<TeenPrivateProjection> {
    const principalEntityId = requireFamilyText(
      input.principalEntityId,
      "principalEntityId",
      200,
    );
    const subjectEntityId = requireFamilyText(
      input.subjectEntityId,
      "subjectEntityId",
      200,
    );
    await this.assertCanonicalEntity(principalEntityId);
    await this.assertCanonicalEntity(subjectEntityId);
    await this.deps.household.requireScope({
      principalEntityId,
      scope: "household.visibility",
      subjectEntityId,
    });
    for (const record of input.records) {
      if (record.subjectEntityId !== subjectEntityId) {
        throw new FamilyCommunicationsError(
          "Teen-private projection records must match the exact subject",
          "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
          {
            recordId: record.recordId,
            expectedSubjectEntityId: subjectEntityId,
            actualSubjectEntityId: record.subjectEntityId,
          },
        );
      }
    }
    if (!input.safeguardingRequest) {
      return {
        principalEntityId,
        subjectEntityId,
        records: [],
        omittedCount: input.records.length,
        omissionNotice:
          "A teen-private record exists, but its contents are omitted.",
        safeguardingDecision: "not_requested",
      };
    }
    const request = input.safeguardingRequest;
    if (
      request.requester.principalEntityId !== principalEntityId ||
      request.subject.entityId !== subjectEntityId ||
      request.privacy.subjectEntityId !== subjectEntityId ||
      request.privacy.recordScope !== "teen_private"
    ) {
      throw new FamilyCommunicationsError(
        "Safeguarding request does not match the exact principal and teen subject",
        "FAMILY_COMMUNICATIONS_ACCESS_DENIED",
        { principalEntityId, subjectEntityId, requestId: request.requestId },
      );
    }
    const decision = evaluateParentingGuidance(request);
    const safetyHandoff =
      decision.status === "urgent_safety_handoff" ||
      decision.status === "safeguarding_handoff";
    if (!safetyHandoff || !decision.mayDisclosePrivateContext) {
      return {
        principalEntityId,
        subjectEntityId,
        records: [],
        omittedCount: input.records.length,
        omissionNotice:
          decision.omissionNotice ??
          "A teen-private record exists, but its contents are omitted.",
        safeguardingDecision: "withheld",
      };
    }
    return {
      principalEntityId,
      subjectEntityId,
      records: input.records.map((record) => ({
        recordId: requireFamilyText(record.recordId, "recordId", 200),
        subjectEntityId,
        summary: requireFamilyText(record.summary, "summary", 2_000),
        sourceRef: requireFamilyText(record.sourceRef, "sourceRef", 500),
      })),
      omittedCount: 0,
      omissionNotice: null,
      safeguardingDecision: decision.status,
    };
  }

  async responseWatcher(
    communicationId: string,
  ): Promise<ScheduledTask | null> {
    const communication =
      await this.deps.repository.getCommunication(communicationId);
    if (!communication?.watcherTaskId) return null;
    return (
      (await this.deps.scheduledTasks.list()).find(
        (task) => task.taskId === communication.watcherTaskId,
      ) ?? null
    );
  }
}

export function createFamilyCommunicationsService(
  runtime: IAgentRuntime,
): FamilyCommunicationsService {
  const graph = resolveKnowledgeGraphService(runtime);
  if (!graph) {
    throw new FamilyCommunicationsError(
      "KnowledgeGraphService is required for family communications",
      "FAMILY_COMMUNICATIONS_PERSISTED_DATA_INVALID",
    );
  }
  const speakerVerifier =
    runtime.getService<FamilyVoiceSpeakerVerifierRuntimeService>(
      FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_SERVICE,
    );
  if (!speakerVerifier || typeof speakerVerifier.verify !== "function") {
    throw new FamilyCommunicationsError(
      "A voice-profile speaker verifier service is required",
      "FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_UNAVAILABLE",
      { serviceType: FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_SERVICE },
    );
  }
  return new FamilyCommunicationsService({
    runtime,
    agentId: runtime.agentId,
    entityStore: graph.getEntityStore(runtime.agentId),
    household:
      getHouseholdCoordinationService(runtime) ??
      createHouseholdCoordinationService(runtime),
    repository: new FamilyCommunicationsRepository(runtime, runtime.agentId),
    speakerVerifier,
    scheduledTasks: getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    }),
  });
}

export class FamilyCommunicationsRuntimeService extends Service {
  static override serviceType = FAMILY_COMMUNICATIONS_SERVICE;

  override capabilityDescription =
    "Verified family voice proposals, co-parent response SLAs, and privacy-scoped child projections";

  readonly family: FamilyCommunicationsService;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new FamilyCommunicationsError(
        "FamilyCommunicationsRuntimeService requires a runtime",
        "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      );
    }
    this.family = createFamilyCommunicationsService(runtime);
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<FamilyCommunicationsRuntimeService> {
    await Promise.all([
      runtime.getServiceLoadPromise(KNOWLEDGE_GRAPH_SERVICE),
      runtime.getServiceLoadPromise(HOUSEHOLD_COORDINATION_SERVICE),
      runtime.getServiceLoadPromise(
        FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_SERVICE,
      ),
      // 120s window: heavy boots on the live box (cold caches, many
      // workspace plugins) register the deferred runner after the default 30s
      // and this service failed for the whole process lifetime (live
      // 2026-08-19, 2 of ~15 boots).
      waitForScheduledTaskRunnerService(runtime, {
        registrationTimeoutMs: 120_000,
      }),
    ]);
    const service = new FamilyCommunicationsRuntimeService(runtime);
    await service.family.initialize();
    return service;
  }

  async stop(): Promise<void> {}
}

export function getFamilyCommunicationsService(
  runtime: IAgentRuntime,
): FamilyCommunicationsService | null {
  return (
    runtime.getService<FamilyCommunicationsRuntimeService>(
      FAMILY_COMMUNICATIONS_SERVICE,
    )?.family ?? null
  );
}
