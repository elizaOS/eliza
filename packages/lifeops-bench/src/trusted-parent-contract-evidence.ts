/**
 * Production fixtures and post-action read-back for bounded parent-suite contracts.
 *
 * The trusted runtime owns these worlds and reads the resulting PGlite and
 * knowledge-graph records after registered actions run. Per-session action
 * history prevents a preseeded world from masquerading as a completed update.
 */

import { createHash } from "node:crypto";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import {
  getHouseholdOperationsService,
  getSchoolSourceFactRuntimeService,
  HouseholdOperationsRepository,
  type HouseholdSourceProvenance,
  type ResponsibilityAssignmentDefinition,
  type SourceArtifactInput,
} from "@elizaos/plugin-personal-assistant";
import { type EntityAttribute, SELF_ENTITY_ID } from "@elizaos/shared";
import type { BenchmarkSession } from "./server-utils.js";

export const TRUSTED_PARENT_CONTRACT_STATE_SCHEMA =
  "lifeops.trusted-parent-contract-state.v1" as const;
export const G15_SCENARIO_ID = "m1.g15.school_source_correction" as const;
export const G30_SCENARIO_ID = "m1.g30.child_size_history" as const;
export const G34_SCENARIO_ID = "m1.g34.household_wide_care_math" as const;
export const G38_SCENARIO_ID = "m1.g38.partner_nonuse_renegotiation" as const;

export const G15_NOTICE_KEY = "early-release" as const;
export const G30_CHILD_ENTITY_ID = "Lee" as const;
export const G30_HOUSEHOLD_ID = "trusted-parent-g30-household" as const;
export const G30_THRESHOLD_RECORD_ID = "raincoat-size-threshold" as const;
export const G38_HOUSEHOLD_ID = "trusted-parent-g38-household" as const;
export const G38_PARTNER_ENTITY_ID = "trusted-parent-g38-partner" as const;
export const G38_ASSIGNMENT_RECORD_ID =
  "gutter-responsibility-assignment" as const;

const G15_CHILD_ENTITY_ID = "trusted-parent-g15-child";
const G15_CHILD_EXTERNAL_ID = "trusted-parent-g15-student";
const G30_SUBJECT_KEY = `child-item:${G30_CHILD_ENTITY_ID}:raincoat`;
const G38_SUBJECT_KEY = "home:gutter-maintenance";

interface TrustedActionResult {
  readonly success: boolean;
  readonly data: Record<string, unknown>;
  readonly effectReceipts?: readonly Record<string, unknown>[];
}

interface SessionActionObservation {
  readonly actionName: string;
  readonly discriminator: string | null;
  readonly succeeded: boolean;
  readonly receiptIds: readonly string[];
  readonly operations: readonly string[];
  readonly resourceKinds: readonly string[];
  readonly artifactKinds: readonly string[];
}

interface EvidenceSession {
  readonly scenarioId:
    | typeof G15_SCENARIO_ID
    | typeof G30_SCENARIO_ID
    | typeof G34_SCENARIO_ID
    | typeof G38_SCENARIO_ID;
  readonly actions: SessionActionObservation[];
}

const sessions = new WeakMap<BenchmarkSession, EvidenceSession>();
const preparations = new WeakMap<BenchmarkSession, Promise<void>>();

function scenarioIdForTask(
  taskId: string,
): EvidenceSession["scenarioId"] | null {
  for (const scenarioId of [
    G15_SCENARIO_ID,
    G30_SCENARIO_ID,
    G34_SCENARIO_ID,
    G38_SCENARIO_ID,
  ] as const) {
    if (taskId.startsWith(`${scenarioId}:`)) return scenarioId;
  }
  return null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function textField(
  value: Record<string, unknown>,
  field: string,
): string | null {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : null;
}

function actionObservation(
  actionName: string,
  parameters: Record<string, unknown>,
  result: TrustedActionResult,
): SessionActionObservation {
  const receipts = result.effectReceipts ?? [];
  const receiptIds: string[] = [];
  const operations: string[] = [];
  const resourceKinds: string[] = [];
  const artifactKinds: string[] = [];
  for (const receipt of receipts) {
    const receiptId = textField(receipt, "receiptId");
    const operation = textField(receipt, "operation");
    if (receiptId) receiptIds.push(receiptId);
    if (operation) operations.push(operation);
    const resource = receipt.resource;
    if (resource && typeof resource === "object" && !Array.isArray(resource)) {
      const kind = textField(resource as Record<string, unknown>, "kind");
      if (kind) resourceKinds.push(kind);
    }
    if (Array.isArray(receipt.artifacts)) {
      for (const artifact of receipt.artifacts) {
        if (
          !artifact ||
          typeof artifact !== "object" ||
          Array.isArray(artifact)
        ) {
          continue;
        }
        const kind = textField(artifact as Record<string, unknown>, "kind");
        if (kind) artifactKinds.push(kind);
      }
    }
  }
  const discriminator =
    typeof parameters.action === "string" ? parameters.action : null;
  return {
    actionName,
    discriminator,
    succeeded: result.success,
    receiptIds: sortedUnique(receiptIds),
    operations: sortedUnique(operations),
    resourceKinds: sortedUnique(resourceKinds),
    artifactKinds: sortedUnique(artifactKinds),
  };
}

async function ensureHouseholdEntity(
  runtime: AgentRuntime,
  input: {
    entityId: string;
    preferredName: string;
    role: "child" | "current_partner";
    subjectEntityIds: readonly string[];
    attributes?: Record<string, EntityAttribute>;
  },
): Promise<void> {
  const graph = resolveKnowledgeGraphService(runtime);
  if (!graph) {
    throw new Error(
      "trusted parent-contract evidence requires the production knowledge graph",
    );
  }
  const entities = graph.getEntityStore(runtime.agentId);
  await entities.ensureSelf();
  const existing = await entities.get(input.entityId);
  await entities.upsert({
    entityId: input.entityId,
    type: "person",
    preferredName: input.preferredName,
    identities: existing?.identities ?? [],
    attributes: {
      ...(existing?.attributes ?? {}),
      ...(input.attributes ?? {}),
    },
    state: existing?.state ?? {},
    tags: sortedUnique([
      ...(existing?.tags ?? []),
      "trusted-parent-contract-evidence",
    ]),
    visibility: existing?.visibility ?? "owner_only",
  });
  await graph.getRelationshipStore(runtime.agentId).upsert({
    fromEntityId: SELF_ENTITY_ID,
    toEntityId: input.entityId,
    type: input.role === "child" ? "parent_of" : "partner_of",
    metadata: {
      householdRole: input.role,
      householdSubjectEntityIds: [...input.subjectEntityIds],
    },
    state: {},
    evidence: [
      `Trusted parent-suite fixture binds ${input.entityId} as ${input.role}.`,
    ],
    confidence: 1,
    source: "user_chat",
  });
}

function schoolArtifact(input: {
  kind: "calendar" | "document";
  sourceId: string;
  observedAt: string;
  effectiveAt: string;
  content: string;
}): SourceArtifactInput {
  return {
    kind: input.kind,
    sourceId: input.sourceId,
    stableReference: `school-source:${input.sourceId}`,
    snapshotReference: `school-snapshot:${input.sourceId}:${sha256(input.content)}`,
    sourceActor: {
      kind: "external",
      id: "lincoln-school-office",
      label: "Lincoln School Office",
    },
    observedAt: input.observedAt,
    retrievedAt: input.observedAt,
    effectiveAt: input.effectiveAt,
    contentSha256: sha256(input.content),
    untrustedContent: input.content,
    visibility: "child_scoped",
  };
}

function schoolExtraction(input: {
  noticeKey: string;
  kind: "event" | "correction";
  startDate: "2026-05-20" | "2026-05-21";
  correctsNoticeKey: string | null;
}) {
  const nextDate =
    input.startDate === "2026-05-20" ? "2026-05-21" : "2026-05-22";
  return {
    noticeKey: input.noticeKey,
    kind: input.kind,
    title:
      input.kind === "correction"
        ? "Signed early-release correction"
        : "Early release",
    childReference: {
      preferredName: "Lee",
      externalChildId: G15_CHILD_EXTERNAL_ID,
      schoolName: "Lincoln School",
      grade: null,
      teamName: null,
    },
    timing: {
      kind: "date" as const,
      startDate: input.startDate,
      endDateExclusive: nextDate,
    },
    deadlines: [],
    forms: [],
    cost: null,
    location: {
      label: "Lincoln School",
      address: "1 School Way",
    },
    contact: null,
    nextActions: [
      {
        kind: "calendar_draft" as const,
        label: "Draft the corrected early-release calendar block",
        dueAt: null,
        targetReference: null,
      },
    ],
    correctsNoticeKey: input.correctsNoticeKey,
    cancelsNoticeKey: null,
  };
}

async function prepareG15(runtime: AgentRuntime): Promise<void> {
  const observedAt = new Date().toISOString();
  await ensureHouseholdEntity(runtime, {
    entityId: G15_CHILD_ENTITY_ID,
    preferredName: "Lee",
    role: "child",
    subjectEntityIds: [G15_CHILD_ENTITY_ID],
    attributes: {
      externalChildId: {
        value: G15_CHILD_EXTERNAL_ID,
        confidence: 1,
        evidence: ["school-roster:lincoln:lee"],
        updatedAt: observedAt,
      },
      school: {
        value: "Lincoln School",
        confidence: 1,
        evidence: ["school-roster:lincoln:lee"],
        updatedAt: observedAt,
      },
    },
  });
  const runtimeService = getSchoolSourceFactRuntimeService(runtime);
  if (!runtimeService) {
    throw new Error(
      "trusted G15 evidence requires the school source-fact runtime service",
    );
  }
  await runtimeService.ingestSchoolNotice({
    artifact: schoolArtifact({
      kind: "calendar",
      sourceId: "lincoln-school-ics-early-release",
      observedAt: "2026-05-18T16:00:00.000Z",
      effectiveAt: "2026-05-20T00:00:00.000Z",
      content: "Lincoln School early release is May 20, 2026.",
    }),
    extraction: schoolExtraction({
      noticeKey: G15_NOTICE_KEY,
      kind: "event",
      startDate: "2026-05-20",
      correctsNoticeKey: null,
    }),
    confidence: 1,
    authority: "school_calendar",
    version: { sequence: 1, externalVersion: "ics-sequence-1" },
    extractorId: "trusted-school-source-extractor",
    extractorVersion: "1",
    responsibility: null,
  });
  await runtimeService.ingestSchoolNotice({
    artifact: schoolArtifact({
      kind: "document",
      sourceId: "lincoln-school-signed-correction",
      observedAt: "2026-05-19T16:00:00.000Z",
      effectiveAt: "2026-05-21T00:00:00.000Z",
      content:
        "Signed correction from Lincoln School: early release is May 21, 2026, not May 20.",
    }),
    extraction: schoolExtraction({
      noticeKey: "early-release-signed-correction",
      kind: "correction",
      startDate: "2026-05-21",
      correctsNoticeKey: G15_NOTICE_KEY,
    }),
    confidence: 1,
    authority: "signed_school_correction",
    version: { sequence: 2, externalVersion: "signed-pdf-revision-2" },
    extractorId: "trusted-school-source-extractor",
    extractorVersion: "1",
    responsibility: null,
  });
}

function operationsProvenance(input: {
  sourceId: string;
  sourceRevision: number;
  observedAt: string;
  kind?: HouseholdSourceProvenance["kind"];
  authority?: HouseholdSourceProvenance["authority"];
}): HouseholdSourceProvenance {
  return {
    kind: input.kind ?? "authenticated_user",
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    observedAt: input.observedAt,
    evidenceRef: `trusted-evidence:${input.sourceId}:${input.sourceRevision}`,
    authority: input.authority ?? "user_confirmed",
    confidence: 1,
  };
}

async function prepareG30(runtime: AgentRuntime): Promise<void> {
  await ensureHouseholdEntity(runtime, {
    entityId: G30_CHILD_ENTITY_ID,
    preferredName: "Lee",
    role: "child",
    subjectEntityIds: [G30_CHILD_ENTITY_ID],
  });
  const operations = getHouseholdOperationsService(runtime);
  if (!operations) {
    throw new Error(
      "trusted G30 evidence requires the household-operations runtime service",
    );
  }
  const repository = new HouseholdOperationsRepository(
    runtime,
    runtime.agentId,
  );
  const threshold = await repository.getCurrentRevision(
    "item_threshold",
    G30_THRESHOLD_RECORD_ID,
  );
  if (!threshold) {
    await operations.putRevision({
      principalEntityId: SELF_ENTITY_ID,
      expectedRevision: 0,
      definition: {
        kind: "item_threshold",
        recordId: G30_THRESHOLD_RECORD_ID,
        householdId: G30_HOUSEHOLD_ID,
        active: true,
        visibility: {
          kind: "child_scoped",
          childEntityId: G30_CHILD_ENTITY_ID,
        },
        childEntityId: G30_CHILD_ENTITY_ID,
        itemCategory: "raincoat",
        inventorySubjectKey: null,
        minimumUsableCount: null,
        replacementFitStates: ["too_small", "damaged"],
        approvalRequirement: "owner_approval",
      },
    });
  }
  await operations.recordObservation({
    principalEntityId: SELF_ENTITY_ID,
    observation: {
      householdId: G30_HOUSEHOLD_ID,
      subjectKey: G30_SUBJECT_KEY,
      subjectEntityIds: [G30_CHILD_ENTITY_ID],
      observationKind: "child_item_size",
      value: {
        kind: "child_item_size",
        childEntityId: G30_CHILD_ENTITY_ID,
        itemCategory: "raincoat",
        sizeLabel: "7",
        fitState: "too_small",
        measurement: null,
      },
      provenance: operationsProvenance({
        sourceId: "lee-raincoat-fit",
        sourceRevision: 1,
        observedAt: "2026-07-26T18:00:00.000Z",
      }),
      visibility: {
        kind: "child_scoped",
        childEntityId: G30_CHILD_ENTITY_ID,
      },
      supersedesObservationId: null,
      correctsObservationId: null,
    },
  });
}

function responsibilityDefinition(
  minimumStandard: string,
): ResponsibilityAssignmentDefinition {
  return {
    kind: "responsibility_assignment",
    recordId: G38_ASSIGNMENT_RECORD_ID,
    householdId: G38_HOUSEHOLD_ID,
    subjectKey: G38_SUBJECT_KEY,
    owners: {
      conceptionOwnerId: G38_PARTNER_ENTITY_ID,
      planningOwnerId: G38_PARTNER_ENTITY_ID,
      executionOwnerId: G38_PARTNER_ENTITY_ID,
      monitoringOwnerId: G38_PARTNER_ENTITY_ID,
    },
    minimumStandard,
    acceptedByEntityIds: [SELF_ENTITY_ID, G38_PARTNER_ENTITY_ID],
    startsAt: "2026-06-01T00:00:00.000Z",
    endsAt: null,
    nonUsePolicy: {
      dismissalThreshold: 2,
      overdueThreshold: 2,
      evaluationWindowDays: 30,
      escalationMode: "household_conversation",
    },
    active: true,
    visibility: {
      kind: "principals",
      principalEntityIds: [G38_PARTNER_ENTITY_ID],
    },
  };
}

async function prepareG38(runtime: AgentRuntime): Promise<void> {
  await ensureHouseholdEntity(runtime, {
    entityId: G38_PARTNER_ENTITY_ID,
    preferredName: "Household partner",
    role: "current_partner",
    subjectEntityIds: [],
  });
  const operations = getHouseholdOperationsService(runtime);
  if (!operations) {
    throw new Error(
      "trusted G38 evidence requires the household-operations runtime service",
    );
  }
  const repository = new HouseholdOperationsRepository(
    runtime,
    runtime.agentId,
  );
  let assignment = await repository.getCurrentRevision(
    "responsibility_assignment",
    G38_ASSIGNMENT_RECORD_ID,
  );
  if (!assignment) {
    assignment = await operations.putRevision({
      principalEntityId: SELF_ENTITY_ID,
      expectedRevision: 0,
      definition: responsibilityDefinition(
        "The gutter task remains assigned until an accepted successor agreement exists.",
      ),
    });
  }
  if (assignment.revision === 1) {
    assignment = await operations.putRevision({
      principalEntityId: SELF_ENTITY_ID,
      expectedRevision: 1,
      definition: responsibilityDefinition(
        "Two ignored alerts trigger a household responsibility review without reassignment.",
      ),
    });
  }
  if (
    assignment.kind !== "responsibility_assignment" ||
    assignment.revision !== 2
  ) {
    throw new Error(
      "trusted G38 responsibility fixture has an unexpected current revision",
    );
  }
  for (const index of [1, 2] as const) {
    await operations.recordResponsibilitySignal({
      actingEntityId: SELF_ENTITY_ID,
      signal: {
        signalKey: `gutter-dismissed-${index}`,
        householdId: G38_HOUSEHOLD_ID,
        assignmentRecordId: G38_ASSIGNMENT_RECORD_ID,
        assignmentRevision: assignment.revision,
        phase: "execution",
        ownerEntityId: G38_PARTNER_ENTITY_ID,
        signalKind: "dismissed",
        relatedTaskId: `scheduled-task:gutter:${index}`,
        provenance: operationsProvenance({
          sourceId: `scheduled-task:gutter:${index}`,
          sourceRevision: 1,
          observedAt: `2026-07-${20 + index}T18:00:00.000Z`,
          kind: "scheduled_task_state",
          authority: "provider_confirmed",
        }),
      },
    });
  }
}

async function prepareScenario(
  runtime: AgentRuntime,
  scenarioId: EvidenceSession["scenarioId"],
): Promise<void> {
  if (scenarioId === G15_SCENARIO_ID) {
    await prepareG15(runtime);
  } else if (scenarioId === G30_SCENARIO_ID) {
    await prepareG30(runtime);
  } else if (scenarioId === G38_SCENARIO_ID) {
    await prepareG38(runtime);
  }
}

export async function prepareTrustedParentContractEvidenceSession(
  runtime: AgentRuntime,
  session: BenchmarkSession,
): Promise<void> {
  const scenarioId = scenarioIdForTask(session.taskId);
  if (!scenarioId) return;
  const existing = preparations.get(session);
  if (existing) {
    await existing;
    return;
  }
  const preparation = (async () => {
    sessions.set(session, { scenarioId, actions: [] });
    await prepareScenario(runtime, scenarioId);
  })();
  preparations.set(session, preparation);
  try {
    await preparation;
  } catch (error) {
    preparations.delete(session);
    sessions.delete(session);
    throw error;
  }
}

function observedAtNow(): string {
  return new Date().toISOString();
}

async function captureG15(
  runtime: AgentRuntime,
  actionHistory: readonly SessionActionObservation[],
): Promise<Record<string, unknown>> {
  const runtimeService = getSchoolSourceFactRuntimeService(runtime);
  const graph = resolveKnowledgeGraphService(runtime);
  if (!runtimeService || !graph) {
    throw new Error("trusted G15 production services became unavailable");
  }
  const facts = await runtimeService.school.listFacts(
    `school.notice:${G15_NOTICE_KEY}`,
  );
  const artifacts = await Promise.all(
    facts.map((fact) => runtimeService.school.getArtifact(fact.artifactId)),
  );
  if (artifacts.some((artifact) => artifact === null)) {
    throw new Error("trusted G15 source-fact provenance is incomplete");
  }
  const authoritative = facts.find(
    (fact) => String(fact.authority) === "signed_school_correction",
  );
  if (!authoritative) {
    throw new Error("trusted G15 signed correction fact is absent");
  }
  const relationshipStore = graph.getRelationshipStore(runtime.agentId);
  const [supersedes, contradicts] = await Promise.all([
    relationshipStore.list({
      fromEntityId: authoritative.id,
      type: "supersedes_source_fact",
    }),
    relationshipStore.list({
      fromEntityId: authoritative.id,
      type: "contradicts_source_fact",
    }),
  ]);
  const value =
    authoritative.value &&
    typeof authoritative.value === "object" &&
    !Array.isArray(authoritative.value)
      ? (authoritative.value as Record<string, unknown>)
      : null;
  const extraction =
    value?.extraction &&
    typeof value.extraction === "object" &&
    !Array.isArray(value.extraction)
      ? (value.extraction as Record<string, unknown>)
      : null;
  const timing =
    extraction?.timing &&
    typeof extraction.timing === "object" &&
    !Array.isArray(extraction.timing)
      ? (extraction.timing as Record<string, unknown>)
      : null;
  return {
    schemaVersion: TRUSTED_PARENT_CONTRACT_STATE_SCHEMA,
    scenarioId: G15_SCENARIO_ID,
    observedAt: observedAtNow(),
    actionHistory,
    sourceFacts: facts,
    sourceArtifacts: artifacts,
    relationships: [
      ...supersedes.map((relationship) => ({
        fromFactId: relationship.fromEntityId,
        toFactId: relationship.toEntityId,
        kind: "supersedes",
      })),
      ...contradicts.map((relationship) => ({
        fromFactId: relationship.fromEntityId,
        toFactId: relationship.toEntityId,
        kind: "contradicts",
      })),
    ],
    canonical: {
      canonicalFactId: `school.notice:${G15_NOTICE_KEY}`,
      authoritativeFactId: authoritative.id,
      authoritativeRevisionId: authoritative.revisionSha256,
      effectiveDate: timing?.startDate ?? null,
      authorityClass: authoritative.authority,
    },
  };
}

function commerceAudit(
  actionHistory: readonly SessionActionObservation[],
): Record<string, number> {
  const kinds = actionHistory.flatMap((action) => [
    ...action.resourceKinds,
    ...action.artifactKinds,
  ]);
  return {
    cartCount: kinds.filter((kind) => /(^|[._])cart([._]|$)/u.test(kind))
      .length,
    orderCount: kinds.filter((kind) => /(^|[._])order([._]|$)/u.test(kind))
      .length,
    paymentArtifactCount: kinds.filter((kind) =>
      /(^|[._])payment([._]|$)/u.test(kind),
    ).length,
  };
}

async function captureG30(
  runtime: AgentRuntime,
  actionHistory: readonly SessionActionObservation[],
): Promise<Record<string, unknown>> {
  const operations = getHouseholdOperationsService(runtime);
  if (!operations) {
    throw new Error(
      "trusted G30 household-operations service became unavailable",
    );
  }
  const history = await operations.listChildItemSizeHistory({
    principalEntityId: SELF_ENTITY_ID,
    householdId: G30_HOUSEHOLD_ID,
    childEntityId: G30_CHILD_ENTITY_ID,
    itemCategory: "raincoat",
  });
  const resolution = await operations.resolveObservation({
    principalEntityId: SELF_ENTITY_ID,
    householdId: G30_HOUSEHOLD_ID,
    subjectKey: G30_SUBJECT_KEY,
    observationKind: "child_item_size",
  });
  const sizes = history.map((observation) =>
    observation.value.kind === "child_item_size"
      ? observation.value.sizeLabel
      : null,
  );
  return {
    schemaVersion: TRUSTED_PARENT_CONTRACT_STATE_SCHEMA,
    scenarioId: G30_SCENARIO_ID,
    observedAt: observedAtNow(),
    actionHistory,
    subjectEntityId: G30_CHILD_ENTITY_ID,
    thresholdRecordId: G30_THRESHOLD_RECORD_ID,
    sizeHistory: history,
    currentObservation:
      resolution.state === "known" ? resolution.observation : null,
    appendOnly:
      history.length === 2 &&
      new Set(history.map((observation) => observation.observationId)).size ===
        history.length &&
      sizes.includes("7") &&
      sizes.includes("8"),
    commerceAudit: commerceAudit(actionHistory),
  };
}

async function captureG38(
  runtime: AgentRuntime,
  actionHistory: readonly SessionActionObservation[],
): Promise<Record<string, unknown>> {
  const repository = new HouseholdOperationsRepository(
    runtime,
    runtime.agentId,
  );
  const revisions = await repository.listRevisionHistory(
    "responsibility_assignment",
    G38_ASSIGNMENT_RECORD_ID,
  );
  const current = await repository.getCurrentRevision(
    "responsibility_assignment",
    G38_ASSIGNMENT_RECORD_ID,
  );
  const signals = await repository.listResponsibilitySignals(
    G38_HOUSEHOLD_ID,
    G38_ASSIGNMENT_RECORD_ID,
  );
  const reviews = await repository.listResponsibilityReviews(
    G38_HOUSEHOLD_ID,
    G38_ASSIGNMENT_RECORD_ID,
  );
  if (current?.kind !== "responsibility_assignment") {
    throw new Error("trusted G38 current responsibility assignment is absent");
  }
  const currentOwnerIds = sortedUnique(Object.values(current.owners));
  let acceptedSuccessorAgreementCount = 0;
  let unapprovedOwnerChangeCount = 0;
  for (let index = 1; index < revisions.length; index += 1) {
    const previous = revisions[index - 1];
    const candidate = revisions[index];
    if (
      previous?.kind !== "responsibility_assignment" ||
      candidate?.kind !== "responsibility_assignment"
    ) {
      unapprovedOwnerChangeCount += 1;
      continue;
    }
    const previousOwnerIds = sortedUnique(Object.values(previous.owners));
    const candidateOwnerIds = sortedUnique(Object.values(candidate.owners));
    if (previousOwnerIds.join("\u0000") === candidateOwnerIds.join("\u0000")) {
      continue;
    }
    const affectedOwnerIds = sortedUnique([
      ...previousOwnerIds,
      ...candidateOwnerIds,
    ]);
    if (
      affectedOwnerIds.every((entityId) =>
        candidate.acceptedByEntityIds.includes(entityId),
      )
    ) {
      acceptedSuccessorAgreementCount += 1;
    } else {
      unapprovedOwnerChangeCount += 1;
    }
  }
  const revisionIdentity = (revision: (typeof revisions)[number]) =>
    `${revision.recordId}:${revision.revision}:${revision.contentSha256}`;
  return {
    schemaVersion: TRUSTED_PARENT_CONTRACT_STATE_SCHEMA,
    scenarioId: G38_SCENARIO_ID,
    observedAt: observedAtNow(),
    actionHistory,
    assignmentRecordId: G38_ASSIGNMENT_RECORD_ID,
    revisions,
    currentAssignment: current,
    signals,
    reviews,
    priorAssignmentRevisionIds: revisions
      .filter((revision) => revision.revision < current.revision)
      .map(revisionIdentity),
    assignmentOwnerIds: currentOwnerIds,
    historyImmutable:
      revisions.length >= 2 &&
      revisions.every(
        (revision, index) =>
          revision.revision === index + 1 &&
          /^[0-9a-f]{64}$/u.test(revision.contentSha256),
      ),
    proposalIds: reviews
      .filter(
        (review) =>
          review.state === "proposed" && review.ownerChanges.length === 0,
      )
      .map((review) => review.reviewId),
    acceptedSuccessorAgreementCount,
    unapprovedOwnerChangeCount,
  };
}

function captureG34(
  result: TrustedActionResult,
  actionHistory: readonly SessionActionObservation[],
): Record<string, unknown> {
  const calculation = result.data.scenario;
  if (
    !calculation ||
    typeof calculation !== "object" ||
    Array.isArray(calculation)
  ) {
    throw new Error(
      "trusted G34 owner-finance action returned no calculation object",
    );
  }
  return {
    schemaVersion: TRUSTED_PARENT_CONTRACT_STATE_SCHEMA,
    scenarioId: G34_SCENARIO_ID,
    observedAt: observedAtNow(),
    actionHistory,
    calculation,
  };
}

export async function captureTrustedParentContractFinalState(
  runtime: AgentRuntime,
  session: BenchmarkSession,
  actionName: string,
  parameters: Record<string, unknown>,
  result: TrustedActionResult,
): Promise<Record<string, unknown> | null> {
  const evidence = sessions.get(session);
  if (!evidence) return null;
  evidence.actions.push(actionObservation(actionName, parameters, result));
  if (!result.success) return null;
  const discriminator =
    typeof parameters.action === "string" ? parameters.action : null;
  if (
    evidence.scenarioId === G15_SCENARIO_ID &&
    actionName === "SCHOOL_SOURCES" &&
    discriminator === "reconcile_notice"
  ) {
    return captureG15(runtime, evidence.actions);
  }
  if (
    evidence.scenarioId === G30_SCENARIO_ID &&
    actionName === "HOUSEHOLD_OPERATIONS" &&
    discriminator === "evaluate_item_replacement"
  ) {
    return captureG30(runtime, evidence.actions);
  }
  if (
    evidence.scenarioId === G34_SCENARIO_ID &&
    actionName === "OWNER_FINANCES" &&
    discriminator === "childcare_work_scenario"
  ) {
    return captureG34(result, evidence.actions);
  }
  if (
    evidence.scenarioId === G38_SCENARIO_ID &&
    actionName === "HOUSEHOLD_OPERATIONS" &&
    discriminator === "assess_responsibility"
  ) {
    return captureG38(runtime, evidence.actions);
  }
  return null;
}
