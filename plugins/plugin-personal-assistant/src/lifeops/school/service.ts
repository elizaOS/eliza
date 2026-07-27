/**
 * Deterministic school-source reconciliation and action-bundle planning.
 *
 * The service consumes extractor output but does not trust source prose or
 * perform external effects. It resolves household children through the runtime
 * graph, retains every source revision, and emits only proposed or blocked
 * action items for the existing approval and scheduling systems to consume.
 */
import {
  type EntityStore,
  type RelationshipStore,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import { type IAgentRuntime, Service } from "@elizaos/core";
import type { Entity, Relationship } from "@elizaos/shared";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { actionBundleId, SchoolSourceFactRepository } from "./repository.js";
import {
  type ActionApprovalRequirement,
  type ActionBundle,
  type ActionBundleItem,
  type ActionEffectClass,
  authorityRank,
  type ChildReference,
  type ChildResolution,
  type ChildResolutionCandidate,
  canonicalSchoolJson,
  type IngestSchoolNoticeInput,
  type IngestSchoolNoticeResult,
  materialNoticeSha256,
  normalizeResponsibilityAssignmentInput,
  normalizeSchoolNoticeExtraction,
  normalizeSourceArtifactInput,
  normalizeSourceFactCandidate,
  type ResponsibilityAssignment,
  type SchoolNoticeExtraction,
  type SchoolNoticeNextAction,
  type SchoolNoticeResolution,
  SchoolSourceFactError,
  type SourceArtifact,
  type SourceArtifactInput,
  type SourceFact,
  type SourceFactCandidate,
  stableSchoolId,
} from "./types.js";

export const SCHOOL_SOURCE_FACT_SERVICE = "lifeops_school_source_facts";
const SCHOOL_NOTICE_FACT_PREFIX = "school.notice:";

interface PersistedSchoolFactValue {
  extraction: SchoolNoticeExtraction;
  childResolutionStatus: ChildResolution["status"];
  childQuestion: string | null;
}

interface SchoolFactProjection {
  fact: SourceFact;
  payload: PersistedSchoolFactValue;
  childEntityId: string | null;
  materialSha256: string;
}

function invalid(message: string, context?: Record<string, unknown>): never {
  throw new SchoolSourceFactError(message, "SCHOOL_INVALID_CONTRACT", context);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${field} must be an object`, { field });
  }
  return value as Record<string, unknown>;
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
}

function attributeStrings(entity: Entity, keys: readonly string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = entity.attributes?.[key]?.value;
    if (typeof value === "string" && value.trim()) {
      values.push(value.trim());
    } else if (Array.isArray(value)) {
      values.push(
        ...value.filter(
          (entry): entry is string =>
            typeof entry === "string" && Boolean(entry.trim()),
        ),
      );
    }
  }
  return values;
}

function includesNormalized(
  values: readonly string[],
  target: string,
): boolean {
  const normalizedTarget = normalizeText(target);
  return values.some((value) => normalizeText(value) === normalizedTarget);
}

function householdRole(relationship: Relationship): string | null {
  const value = relationship.metadata?.householdRole;
  return typeof value === "string" ? value : null;
}

function canonicalNoticeKey(extraction: SchoolNoticeExtraction): string {
  if (extraction.kind === "correction") {
    if (!extraction.correctsNoticeKey) {
      return invalid("Correction is missing correctsNoticeKey");
    }
    return extraction.correctsNoticeKey;
  }
  if (extraction.kind === "cancellation") {
    if (!extraction.cancelsNoticeKey) {
      return invalid("Cancellation is missing cancelsNoticeKey");
    }
    return extraction.cancelsNoticeKey;
  }
  return extraction.noticeKey;
}

function schoolFactValue(fact: SourceFact): PersistedSchoolFactValue {
  const record = asRecord(fact.value, `sourceFact(${fact.id}).value`);
  const extraction = normalizeSchoolNoticeExtraction(record.extraction);
  const status = record.childResolutionStatus;
  if (
    status !== "resolved" &&
    status !== "ambiguous" &&
    status !== "unresolved"
  ) {
    return invalid("Persisted school fact has invalid childResolutionStatus", {
      factId: fact.id,
    });
  }
  const question =
    record.childQuestion === null
      ? null
      : typeof record.childQuestion === "string" && record.childQuestion.trim()
        ? record.childQuestion
        : invalid("Persisted school fact has invalid childQuestion", {
            factId: fact.id,
          });
  return {
    extraction,
    childResolutionStatus: status,
    childQuestion: question,
  };
}

function schoolFactProjection(fact: SourceFact): SchoolFactProjection {
  const payload = schoolFactValue(fact);
  if (fact.subjectEntityIds.length > 1) {
    return invalid("School notice facts may never target more than one child", {
      factId: fact.id,
      subjectEntityIds: fact.subjectEntityIds,
    });
  }
  const childEntityId = fact.subjectEntityIds[0] ?? null;
  if (
    (payload.childResolutionStatus === "resolved") !==
    (childEntityId !== null)
  ) {
    return invalid("School fact child resolution does not match its subjects", {
      factId: fact.id,
    });
  }
  return {
    fact,
    payload,
    childEntityId,
    materialSha256: materialNoticeSha256(payload.extraction, childEntityId),
  };
}

function nextActionPolicy(action: SchoolNoticeNextAction): {
  effectClass: ActionEffectClass;
  approvalRequirement: ActionApprovalRequirement;
} {
  if (action.kind === "review") {
    return { effectClass: "read_only", approvalRequirement: "none" };
  }
  if (action.kind === "prepare") {
    return {
      effectClass: "internal_reversible",
      approvalRequirement: "none",
    };
  }
  if (action.kind === "calendar_draft") {
    return {
      effectClass: "calendar_write",
      approvalRequirement: "owner_approval",
    };
  }
  if (action.kind === "send_draft") {
    return {
      effectClass: "external_send",
      approvalRequirement: "owner_approval",
    };
  }
  if (action.kind === "purchase_draft") {
    return {
      effectClass: "purchase",
      approvalRequirement: "owner_approval",
    };
  }
  return {
    effectClass: "document_submission",
    approvalRequirement: "owner_approval",
  };
}

function consequenceItems(
  resolution: SchoolNoticeResolution,
): ActionBundleItem[] {
  if (resolution.state === "conflicted") {
    return [
      {
        id: stableSchoolId("item", {
          noticeKey: resolution.noticeKey,
          kind: "resolve_conflict",
          sourceFactIds: resolution.contradictionFactIds,
        }),
        kind: "resolve_conflict",
        label: "Resolve the contradictory school source revisions.",
        dueAt: null,
        targetReference: null,
        effectClass: "internal_reversible",
        approvalRequirement: "none",
        state: "blocked",
      },
    ];
  }
  if (resolution.state === "needs_clarification") {
    return [
      {
        id: stableSchoolId("item", {
          noticeKey: resolution.noticeKey,
          kind: "clarify_child",
          sourceFactIds: resolution.currentFactIds,
        }),
        kind: "clarify_child",
        label: "Confirm which child, school, or team this notice applies to.",
        dueAt: null,
        targetReference: null,
        effectClass: "internal_reversible",
        approvalRequirement: "none",
        state: "blocked",
      },
    ];
  }
  if (resolution.state === "cancelled") return [];
  return resolution.extraction.nextActions.map((action, index) => {
    const policy = nextActionPolicy(action);
    return {
      id: stableSchoolId("item", {
        noticeKey: resolution.noticeKey,
        materialSha256: resolution.materialSha256,
        index,
        action,
      }),
      ...action,
      ...policy,
      state: "proposed",
    };
  });
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function bundleMatches(
  bundle: ActionBundle,
  input: Omit<ActionBundle, "id" | "revision" | "createdAt">,
): boolean {
  return (
    bundle.noticeKey === input.noticeKey &&
    sameStringSet(bundle.sourceFactIds, input.sourceFactIds) &&
    bundle.childEntityId === input.childEntityId &&
    bundle.state === input.state &&
    bundle.responsibilityAssignmentId === input.responsibilityAssignmentId &&
    canonicalSchoolJson(bundle.items) === canonicalSchoolJson(input.items)
  );
}

export interface SchoolSourceFactServiceDependencies {
  runtime: IAgentRuntime;
  agentId: string;
  entityStore: EntityStore;
  relationshipStore: RelationshipStore;
  repository: SchoolSourceFactRepository;
  now?: () => Date;
}

export class SchoolSourceFactService {
  private readonly now: () => Date;

  constructor(private readonly deps: SchoolSourceFactServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  static create(
    runtime: IAgentRuntime,
    options?: { agentId?: string; now?: () => Date },
  ): SchoolSourceFactService {
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) {
      throw new SchoolSourceFactError(
        "Runtime knowledge graph service is unavailable",
        "SCHOOL_GRAPH_UNAVAILABLE",
        { agentId: options?.agentId ?? runtime.agentId },
      );
    }
    const agentId = options?.agentId ?? runtime.agentId;
    const entityStore = graph.getEntityStore(agentId);
    const relationshipStore = graph.getRelationshipStore(agentId);
    return new SchoolSourceFactService({
      runtime,
      agentId,
      entityStore,
      relationshipStore,
      repository: new SchoolSourceFactRepository(
        agentId,
        entityStore,
        relationshipStore,
      ),
      now: options?.now,
    });
  }

  async captureCandidates(
    artifactValue: SourceArtifactInput,
    candidateValues: readonly SourceFactCandidate[],
  ): Promise<{ artifact: SourceArtifact; sourceFacts: SourceFact[] }> {
    const artifactInput = normalizeSourceArtifactInput(artifactValue);
    await this.requireSourceActor(artifactInput);
    const artifact = await this.deps.repository.putArtifact(artifactInput);
    const sourceFacts: SourceFact[] = [];
    for (const candidateValue of candidateValues) {
      const candidate = normalizeSourceFactCandidate(candidateValue);
      await this.requireEntities(candidate.subjectEntityIds);
      const fact = await this.deps.repository.putFact(artifact, candidate);
      sourceFacts.push(fact);
      await this.linkDeclaredFactRelationships(fact, artifact.observedAt);
    }
    return { artifact, sourceFacts };
  }

  async ingestSchoolNotice(
    inputValue: IngestSchoolNoticeInput,
  ): Promise<IngestSchoolNoticeResult> {
    const artifactInput = normalizeSourceArtifactInput(inputValue.artifact);
    const extraction = normalizeSchoolNoticeExtraction(inputValue.extraction);
    const responsibility = inputValue.responsibility
      ? normalizeResponsibilityAssignmentInput(inputValue.responsibility)
      : null;
    await this.requireSourceActor(artifactInput);
    if (extraction.contact?.entityId) {
      await this.requireEntity(extraction.contact.entityId);
    }

    const childResolution = await this.resolveChild(extraction.childReference);
    const childEntityId =
      childResolution.status === "resolved" ? childResolution.entityId : null;
    const noticeKey = canonicalNoticeKey(extraction);
    const artifact = await this.deps.repository.putArtifact(artifactInput);
    const candidate = normalizeSourceFactCandidate({
      stableFactKey: `${SCHOOL_NOTICE_FACT_PREFIX}${noticeKey}`,
      domain: "school",
      factType: `school_notice.${extraction.kind}`,
      value: {
        extraction,
        childResolutionStatus: childResolution.status,
        childQuestion:
          childResolution.status === "resolved"
            ? null
            : childResolution.question,
      },
      subjectEntityIds: childEntityId ? [childEntityId] : [],
      confidence: inputValue.confidence,
      authority: inputValue.authority,
      version: inputValue.version,
      effectiveFrom: this.effectiveFrom(extraction, artifactInput),
      effectiveUntil: this.effectiveUntil(extraction),
      visibility: artifactInput.visibility,
      extractorId: inputValue.extractorId,
      extractorVersion: inputValue.extractorVersion,
      supersedesStableFactKeys:
        extraction.kind === "correction" || extraction.kind === "cancellation"
          ? [`${SCHOOL_NOTICE_FACT_PREFIX}${noticeKey}`]
          : [],
      contradictsStableFactKeys: [],
    });
    const sourceFact = await this.deps.repository.putFact(artifact, candidate);
    await this.linkDeclaredFactRelationships(sourceFact, artifact.observedAt);

    let responsibilityAssignment: ResponsibilityAssignment | null = null;
    if (responsibility) {
      await this.requireEntities([
        responsibility.conceptionOwnerId,
        responsibility.planningOwnerId,
        responsibility.executionOwnerId,
        responsibility.monitoringOwnerId,
        ...responsibility.acceptedBy,
      ]);
      responsibilityAssignment = await this.deps.repository.putResponsibility(
        responsibility,
        this.now().toISOString(),
      );
    }
    const { resolution, bundle } = await this.reconcileNotice(
      noticeKey,
      responsibilityAssignment?.id ?? null,
    );
    return {
      artifact,
      sourceFact,
      childResolution,
      noticeResolution: resolution,
      actionBundle: bundle,
      responsibilityAssignment,
    };
  }

  async resolveChild(reference: ChildReference): Promise<ChildResolution> {
    const children = await this.listHouseholdChildren();
    const candidates = children
      .map((entity) => this.scoreChild(entity, reference))
      .filter(
        (
          candidate,
        ): candidate is ChildResolutionCandidate & { score: number } =>
          candidate !== null,
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.entityId.localeCompare(right.entityId),
      );

    if (reference.externalChildId) {
      const exact = candidates.filter((candidate) =>
        candidate.matchedHints.includes("externalChildId"),
      );
      if (exact.length === 1) {
        return {
          status: "resolved",
          entityId: exact[0].entityId,
          matchedHints: exact[0].matchedHints,
        };
      }
      if (exact.length > 1) {
        return {
          status: "ambiguous",
          candidates: exact.map(({ score: _score, ...candidate }) => candidate),
          question:
            "More than one household child has this school identifier. Confirm the child before writing any dependent record.",
        };
      }
      return {
        status: "unresolved",
        candidates: candidates.map(
          ({ score: _score, ...candidate }) => candidate,
        ),
        question:
          "No household child matches this school identifier. Confirm the child before writing any dependent record.",
      };
    }

    if (candidates.length === 0) {
      return {
        status: "unresolved",
        candidates: [],
        question:
          "Which household child, school, or team does this notice apply to?",
      };
    }
    const bestScore = candidates[0].score;
    const best = candidates.filter(
      (candidate) => candidate.score === bestScore,
    );
    if (best.length !== 1) {
      return {
        status: "ambiguous",
        candidates: best.map(({ score: _score, ...candidate }) => candidate),
        question:
          "More than one household child matches these details. Confirm the child, school, grade, or team before writing any dependent record.",
      };
    }
    return {
      status: "resolved",
      entityId: best[0].entityId,
      matchedHints: best[0].matchedHints,
    };
  }

  async reconcileNotice(
    noticeKeyValue: string,
    explicitResponsibilityAssignmentId: string | null = null,
  ): Promise<{ resolution: SchoolNoticeResolution; bundle: ActionBundle }> {
    const noticeKey = noticeKeyValue.trim();
    if (!noticeKey) return invalid("noticeKey must be a non-empty string");
    const facts = await this.deps.repository.listFacts(
      `${SCHOOL_NOTICE_FACT_PREFIX}${noticeKey}`,
    );
    if (facts.length === 0) {
      throw new SchoolSourceFactError(
        `No source facts exist for school notice ${noticeKey}`,
        "SCHOOL_SOURCE_NOT_FOUND",
        { noticeKey },
      );
    }
    const projections = facts.map(schoolFactProjection);
    const highestAuthority = Math.max(
      ...projections.map((projection) =>
        authorityRank(projection.fact.authority),
      ),
    );
    const authorityWinners = projections.filter(
      (projection) =>
        authorityRank(projection.fact.authority) === highestAuthority,
    );
    const highestVersion = Math.max(
      ...authorityWinners.map((projection) => projection.fact.version.sequence),
    );
    const top = authorityWinners.filter(
      (projection) => projection.fact.version.sequence === highestVersion,
    );
    const distinctMaterials = new Set(
      top.map((projection) => projection.materialSha256),
    );
    let resolution: SchoolNoticeResolution;
    if (distinctMaterials.size > 1) {
      const contradictionFactIds = top
        .map((projection) => projection.fact.id)
        .sort();
      const topIds = new Set(contradictionFactIds);
      const supersededFactIds = projections
        .filter((projection) => !topIds.has(projection.fact.id))
        .map((projection) => projection.fact.id)
        .sort();
      resolution = {
        noticeKey,
        state: "conflicted",
        currentFactIds: [],
        supersededFactIds,
        contradictionFactIds,
        materialSha256: null,
        extraction: null,
        childEntityId: null,
      };
      for (let left = 0; left < top.length; left += 1) {
        for (let right = left + 1; right < top.length; right += 1) {
          await this.deps.repository.linkFacts({
            fromFactId: top[left].fact.id,
            toFactId: top[right].fact.id,
            type: "contradicts_source_fact",
            occurredAt: this.now().toISOString(),
          });
          await this.deps.repository.linkFacts({
            fromFactId: top[right].fact.id,
            toFactId: top[left].fact.id,
            type: "contradicts_source_fact",
            occurredAt: this.now().toISOString(),
          });
        }
      }
    } else {
      const winner = top[0];
      const current = projections.filter(
        (projection) => projection.materialSha256 === winner.materialSha256,
      );
      const currentIds = new Set(
        current.map((projection) => projection.fact.id),
      );
      const superseded = projections.filter(
        (projection) => !currentIds.has(projection.fact.id),
      );
      const state =
        winner.payload.extraction.kind === "cancellation"
          ? "cancelled"
          : winner.payload.childResolutionStatus === "resolved"
            ? "active"
            : "needs_clarification";
      resolution = {
        noticeKey,
        state,
        currentFactIds: current.map((projection) => projection.fact.id).sort(),
        supersededFactIds: superseded
          .map((projection) => projection.fact.id)
          .sort(),
        contradictionFactIds: [],
        materialSha256: winner.materialSha256,
        extraction: winner.payload.extraction,
        childEntityId: winner.childEntityId,
      };
      for (const currentFact of current) {
        for (const prior of superseded) {
          await this.deps.repository.linkFacts({
            fromFactId: currentFact.fact.id,
            toFactId: prior.fact.id,
            type: "supersedes_source_fact",
            occurredAt: this.now().toISOString(),
          });
        }
      }
    }

    const existingBundles =
      await this.deps.repository.listActionBundles(noticeKey);
    const responsibilityAssignmentId =
      explicitResponsibilityAssignmentId ??
      existingBundles
        .slice()
        .reverse()
        .find((bundle) => bundle.responsibilityAssignmentId !== null)
        ?.responsibilityAssignmentId ??
      null;
    const items = consequenceItems(resolution);
    const state = resolution.state === "active" ? "proposed" : resolution.state;
    const bundleInput = {
      noticeKey,
      sourceFactIds:
        resolution.state === "conflicted"
          ? resolution.contradictionFactIds
          : resolution.currentFactIds,
      childEntityId:
        resolution.state === "conflicted" ? null : resolution.childEntityId,
      state,
      items,
      responsibilityAssignmentId,
    } satisfies Omit<ActionBundle, "id" | "revision" | "createdAt">;
    const replay = existingBundles.find((bundle) =>
      bundleMatches(bundle, bundleInput),
    );
    if (replay) return { resolution, bundle: replay };

    const revision =
      existingBundles.reduce(
        (highest, bundle) => Math.max(highest, bundle.revision),
        0,
      ) + 1;
    const createdAt = this.now().toISOString();
    const bundle: ActionBundle = {
      ...bundleInput,
      revision,
      createdAt,
      id: actionBundleId({
        agentId: this.deps.agentId,
        ...bundleInput,
        revision,
      }),
    };
    const persisted = await this.deps.repository.putActionBundle(
      bundle,
      existingBundles.map((existing) => existing.id),
    );
    return { resolution, bundle: persisted };
  }

  async listCurrentActionBundles(noticeKey: string): Promise<ActionBundle[]> {
    const bundles = await this.deps.repository.listActionBundles(noticeKey);
    const relationships = await this.deps.repository.listRelationships({
      type: "supersedes_action_bundle",
    });
    const supersededIds = new Set(
      relationships.map((relationship) => relationship.toEntityId),
    );
    return bundles.filter((bundle) => !supersededIds.has(bundle.id));
  }

  async listFacts(stableFactKey?: string): Promise<SourceFact[]> {
    return this.deps.repository.listFacts(stableFactKey);
  }

  async listActionBundles(noticeKey?: string): Promise<ActionBundle[]> {
    return this.deps.repository.listActionBundles(noticeKey);
  }

  async getArtifact(id: string): Promise<SourceArtifact | null> {
    return this.deps.repository.getArtifact(id);
  }

  async getResponsibility(
    id: string,
  ): Promise<ResponsibilityAssignment | null> {
    return this.deps.repository.getResponsibility(id);
  }

  private async listHouseholdChildren(): Promise<Entity[]> {
    const relationships = await this.deps.relationshipStore.list({
      fromEntityId: SELF_ENTITY_ID,
    });
    const childIds = Array.from(
      new Set(
        relationships
          .filter(
            (relationship) =>
              relationship.status === "active" &&
              householdRole(relationship) === "child",
          )
          .map((relationship) => relationship.toEntityId),
      ),
    ).sort();
    const children: Entity[] = [];
    for (const childId of childIds) {
      children.push(await this.requireEntity(childId));
    }
    return children;
  }

  private scoreChild(
    entity: Entity,
    reference: ChildReference,
  ): (ChildResolutionCandidate & { score: number }) | null {
    const matchedHints: string[] = [];
    let score = 0;
    const names = [
      entity.preferredName,
      ...(entity.fullName ? [entity.fullName] : []),
      ...attributeStrings(entity, ["aliases", "schoolAliases"]),
    ];
    if (reference.preferredName) {
      if (!includesNormalized(names, reference.preferredName)) return null;
      matchedHints.push("preferredName");
      score += 20;
    }
    if (reference.externalChildId) {
      const ids = attributeStrings(entity, [
        "externalChildId",
        "externalSchoolIds",
        "studentIds",
      ]);
      if (includesNormalized(ids, reference.externalChildId)) {
        matchedHints.push("externalChildId");
        score += 100;
      }
    }
    if (reference.schoolName) {
      const schools = attributeStrings(entity, [
        "school",
        "schoolName",
        "schools",
      ]);
      if (includesNormalized(schools, reference.schoolName)) {
        matchedHints.push("schoolName");
        score += 30;
      }
    }
    if (reference.grade) {
      const grades = attributeStrings(entity, ["grade", "schoolGrade"]);
      if (includesNormalized(grades, reference.grade)) {
        matchedHints.push("grade");
        score += 15;
      }
    }
    if (reference.teamName) {
      const teams = attributeStrings(entity, [
        "team",
        "teamName",
        "teamNames",
        "activities",
      ]);
      if (includesNormalized(teams, reference.teamName)) {
        matchedHints.push("teamName");
        score += 30;
      }
    }
    if (score === 0) return null;
    return {
      entityId: entity.entityId,
      preferredName: entity.preferredName,
      matchedHints,
      score,
    };
  }

  private async requireSourceActor(
    artifact: SourceArtifactInput,
  ): Promise<void> {
    if (artifact.sourceActor.kind === "entity") {
      await this.requireEntity(artifact.sourceActor.id);
    }
  }

  private async requireEntities(entityIds: readonly string[]): Promise<void> {
    for (const entityId of Array.from(new Set(entityIds))) {
      await this.requireEntity(entityId);
    }
  }

  private async requireEntity(entityId: string): Promise<Entity> {
    const entity = await this.deps.entityStore.get(entityId);
    if (!entity) {
      throw new SchoolSourceFactError(
        `Knowledge-graph entity ${entityId} does not exist`,
        "SCHOOL_SUBJECT_NOT_FOUND",
        { entityId },
      );
    }
    return entity;
  }

  private effectiveFrom(
    extraction: SchoolNoticeExtraction,
    artifact: SourceArtifactInput,
  ): string | null {
    if (extraction.timing?.kind === "instant") {
      return extraction.timing.startAt;
    }
    return artifact.effectiveAt;
  }

  private effectiveUntil(extraction: SchoolNoticeExtraction): string | null {
    return extraction.timing?.kind === "instant"
      ? extraction.timing.endAt
      : null;
  }

  private async linkDeclaredFactRelationships(
    fact: SourceFact,
    occurredAt: string,
  ): Promise<void> {
    const supersedes = new Set(fact.supersedesStableFactKeys);
    const contradicts = new Set(fact.contradictsStableFactKeys);
    for (const stableFactKey of new Set([...supersedes, ...contradicts])) {
      const targets = await this.deps.repository.listFacts(stableFactKey);
      for (const target of targets) {
        if (target.id === fact.id) continue;
        if (supersedes.has(stableFactKey)) {
          await this.deps.repository.linkFacts({
            fromFactId: fact.id,
            toFactId: target.id,
            type: "supersedes_source_fact",
            occurredAt,
          });
        }
        if (contradicts.has(stableFactKey)) {
          await this.deps.repository.linkFacts({
            fromFactId: fact.id,
            toFactId: target.id,
            type: "contradicts_source_fact",
            occurredAt,
          });
        }
      }
    }
  }
}

export class SchoolSourceFactRuntimeService extends Service {
  static override serviceType = SCHOOL_SOURCE_FACT_SERVICE;

  override capabilityDescription =
    "Immutable school source facts, child disambiguation, correction reconciliation, safe action bundles, and structural C/P/E/M ownership";

  readonly school: SchoolSourceFactService;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new SchoolSourceFactError(
        "SchoolSourceFactRuntimeService requires a runtime",
        "SCHOOL_INVALID_CONTRACT",
      );
    }
    this.school = SchoolSourceFactService.create(runtime);
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<SchoolSourceFactRuntimeService> {
    return new SchoolSourceFactRuntimeService(runtime);
  }

  async stop(): Promise<void> {}

  ingestSchoolNotice(
    input: IngestSchoolNoticeInput,
  ): Promise<IngestSchoolNoticeResult> {
    return this.school.ingestSchoolNotice(input);
  }

  captureCandidates(
    artifact: SourceArtifactInput,
    candidates: readonly SourceFactCandidate[],
  ): Promise<{ artifact: SourceArtifact; sourceFacts: SourceFact[] }> {
    return this.school.captureCandidates(artifact, candidates);
  }

  reconcileNotice(
    noticeKey: string,
  ): Promise<{ resolution: SchoolNoticeResolution; bundle: ActionBundle }> {
    return this.school.reconcileNotice(noticeKey);
  }
}

export function getSchoolSourceFactRuntimeService(
  runtime: IAgentRuntime,
): SchoolSourceFactRuntimeService | null {
  return runtime.getService<SchoolSourceFactRuntimeService>(
    SCHOOL_SOURCE_FACT_SERVICE,
  );
}
