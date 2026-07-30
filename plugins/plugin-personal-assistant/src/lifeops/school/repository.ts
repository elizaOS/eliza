/**
 * Immutable source-fact persistence on the runtime knowledge graph.
 *
 * Snapshots, fact revisions, action bundles, and responsibility assignments
 * are content-addressed graph entities. Typed edges preserve provenance,
 * supersession, contradictions, child scope, action influence, and C/P/E/M
 * ownership without introducing another graph or a parallel scheduler.
 */
import type { EntityStore, RelationshipStore } from "@elizaos/agent";
import type { Entity, Relationship } from "@elizaos/shared";
import {
  ACTION_EFFECT_CLASSES,
  type ActionBundle,
  type ActionBundleItem,
  canonicalSchoolJson,
  normalizeResponsibilityAssignmentInput,
  normalizeSourceArtifactInput,
  normalizeSourceFactCandidate,
  type ResponsibilityAssignment,
  type ResponsibilityAssignmentInput,
  SCHOOL_NOTICE_ACTION_KINDS,
  SchoolSourceFactError,
  type SourceArtifact,
  type SourceArtifactInput,
  type SourceFact,
  type SourceFactCandidate,
  sha256,
  sourceFactRevisionSha256,
  stableSchoolId,
} from "./types.js";

const SOURCE_ARTIFACT_ATTRIBUTE = "school.source_artifact.v1";
const SOURCE_FACT_ATTRIBUTE = "school.source_fact.v1";
const ACTION_BUNDLE_ATTRIBUTE = "school.action_bundle.v1";
const RESPONSIBILITY_ATTRIBUTE = "school.responsibility.v1";

const SOURCE_ARTIFACT_TAG = "lifeops:source-artifact";
const SOURCE_FACT_TAG = "lifeops:source-fact";
const ACTION_BUNDLE_TAG = "lifeops:action-bundle";
const RESPONSIBILITY_TAG = "lifeops:responsibility-assignment";
const ACTION_BUNDLE_ITEM_KINDS: readonly ActionBundleItem["kind"][] = [
  ...SCHOOL_NOTICE_ACTION_KINDS,
  "clarify_child",
  "resolve_conflict",
];

function invalidPersisted(
  message: string,
  context?: Record<string, unknown>,
): never {
  throw new SchoolSourceFactError(
    message,
    "SCHOOL_IMMUTABLE_CONFLICT",
    context,
  );
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidPersisted(`Persisted ${field} is not an object`, { field });
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return invalidPersisted(`Persisted ${field} is missing`, { field });
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return invalidPersisted(`Persisted ${field} is not a positive integer`, {
      field,
    });
  }
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredText(value, field);
}

function attributeValue(entity: Entity, key: string): unknown {
  const attribute = entity.attributes?.[key];
  if (!attribute) {
    return invalidPersisted(`Entity ${entity.entityId} is missing ${key}`, {
      entityId: entity.entityId,
      key,
    });
  }
  return attribute.value;
}

function artifactFromEntity(entity: Entity): SourceArtifact {
  const contract = recordValue(
    attributeValue(entity, SOURCE_ARTIFACT_ATTRIBUTE),
    SOURCE_ARTIFACT_ATTRIBUTE,
  );
  const input = normalizeSourceArtifactInput(contract);
  const artifact: SourceArtifact = {
    ...input,
    id: requiredText(contract.id, "sourceArtifact.id"),
    createdAt: requiredText(contract.createdAt, "sourceArtifact.createdAt"),
  };
  if (artifact.id !== entity.entityId) {
    return invalidPersisted("Source artifact id does not match graph entity", {
      entityId: entity.entityId,
      artifactId: artifact.id,
    });
  }
  return artifact;
}

function factFromEntity(entity: Entity): SourceFact {
  const contract = recordValue(
    attributeValue(entity, SOURCE_FACT_ATTRIBUTE),
    SOURCE_FACT_ATTRIBUTE,
  );
  const candidate = normalizeSourceFactCandidate(contract.candidate);
  const fact: SourceFact = {
    ...candidate,
    id: requiredText(contract.id, "sourceFact.id"),
    artifactId: requiredText(contract.artifactId, "sourceFact.artifactId"),
    revisionSha256: requiredText(
      contract.revisionSha256,
      "sourceFact.revisionSha256",
    ),
    createdAt: requiredText(contract.createdAt, "sourceFact.createdAt"),
  };
  if (fact.id !== entity.entityId) {
    return invalidPersisted("Source fact id does not match graph entity", {
      entityId: entity.entityId,
      factId: fact.id,
    });
  }
  if (
    fact.revisionSha256 !== sourceFactRevisionSha256(fact.artifactId, candidate)
  ) {
    return invalidPersisted("Source fact revision hash is invalid", {
      factId: fact.id,
    });
  }
  return fact;
}

function actionItemFromValue(value: unknown, index: number): ActionBundleItem {
  const record = recordValue(value, `actionBundle.items[${index}]`);
  const effectClassText = requiredText(
    record.effectClass,
    `actionBundle.items[${index}].effectClass`,
  );
  const effectClass = ACTION_EFFECT_CLASSES.find(
    (candidate) => candidate === effectClassText,
  );
  if (!effectClass) {
    return invalidPersisted("Persisted action bundle has invalid effectClass", {
      index,
      effectClass: effectClassText,
    });
  }
  const approvalRequirement = requiredText(
    record.approvalRequirement,
    `actionBundle.items[${index}].approvalRequirement`,
  );
  if (
    approvalRequirement !== "none" &&
    approvalRequirement !== "owner_approval" &&
    approvalRequirement !== "multi_party_approval"
  ) {
    return invalidPersisted(
      "Persisted action bundle has invalid approvalRequirement",
      { index, approvalRequirement },
    );
  }
  const state = requiredText(
    record.state,
    `actionBundle.items[${index}].state`,
  );
  if (state !== "proposed" && state !== "blocked") {
    return invalidPersisted("Persisted action bundle has invalid item state", {
      index,
      state,
    });
  }
  const kindText = requiredText(
    record.kind,
    `actionBundle.items[${index}].kind`,
  );
  const kind = ACTION_BUNDLE_ITEM_KINDS.find(
    (candidate) => candidate === kindText,
  );
  if (!kind) {
    return invalidPersisted("Persisted action bundle has invalid item kind", {
      index,
      kind: kindText,
    });
  }
  return {
    id: requiredText(record.id, `actionBundle.items[${index}].id`),
    kind,
    label: requiredText(record.label, `actionBundle.items[${index}].label`),
    dueAt: nullableText(record.dueAt, `actionBundle.items[${index}].dueAt`),
    targetReference: nullableText(
      record.targetReference,
      `actionBundle.items[${index}].targetReference`,
    ),
    effectClass,
    approvalRequirement,
    state,
  };
}

function actionBundleFromEntity(entity: Entity): ActionBundle {
  const contract = recordValue(
    attributeValue(entity, ACTION_BUNDLE_ATTRIBUTE),
    ACTION_BUNDLE_ATTRIBUTE,
  );
  if (!Array.isArray(contract.sourceFactIds)) {
    return invalidPersisted(
      "Persisted actionBundle.sourceFactIds is not an array",
    );
  }
  if (!Array.isArray(contract.items)) {
    return invalidPersisted("Persisted actionBundle.items is not an array");
  }
  const state = requiredText(contract.state, "actionBundle.state");
  if (
    state !== "proposed" &&
    state !== "needs_clarification" &&
    state !== "conflicted" &&
    state !== "cancelled"
  ) {
    return invalidPersisted("Persisted actionBundle.state is invalid", {
      state,
    });
  }
  const sourceFactIds = contract.sourceFactIds.map((value, index) =>
    requiredText(value, `actionBundle.sourceFactIds[${index}]`),
  );
  const bundle: ActionBundle = {
    id: requiredText(contract.id, "actionBundle.id"),
    noticeKey: requiredText(contract.noticeKey, "actionBundle.noticeKey"),
    sourceFactIds,
    childEntityId: nullableText(
      contract.childEntityId,
      "actionBundle.childEntityId",
    ),
    revision: requiredInteger(contract.revision, "actionBundle.revision"),
    state,
    items: contract.items.map(actionItemFromValue),
    responsibilityAssignmentId: nullableText(
      contract.responsibilityAssignmentId,
      "actionBundle.responsibilityAssignmentId",
    ),
    createdAt: requiredText(contract.createdAt, "actionBundle.createdAt"),
  };
  if (bundle.id !== entity.entityId) {
    return invalidPersisted("Action bundle id does not match graph entity", {
      entityId: entity.entityId,
      bundleId: bundle.id,
    });
  }
  assertSafeActionBundle(bundle);
  return bundle;
}

function responsibilityFromEntity(entity: Entity): ResponsibilityAssignment {
  const contract = recordValue(
    attributeValue(entity, RESPONSIBILITY_ATTRIBUTE),
    RESPONSIBILITY_ATTRIBUTE,
  );
  const input = normalizeResponsibilityAssignmentInput(contract);
  const assignment: ResponsibilityAssignment = {
    ...input,
    id: requiredText(contract.id, "responsibility.id"),
    createdAt: requiredText(contract.createdAt, "responsibility.createdAt"),
  };
  if (assignment.id !== entity.entityId) {
    return invalidPersisted(
      "Responsibility assignment id does not match graph entity",
      { entityId: entity.entityId, assignmentId: assignment.id },
    );
  }
  return assignment;
}

function entityInput(args: {
  id: string;
  type: "concept" | "project";
  name: string;
  tag: string;
  attributeKey: string;
  contract: unknown;
  confidence: number;
  evidence: string[];
  observedAt: string;
}) {
  return {
    entityId: args.id,
    type: args.type,
    preferredName: args.name,
    identities: [],
    attributes: {
      [args.attributeKey]: {
        value: args.contract,
        confidence: args.confidence,
        evidence: args.evidence,
        updatedAt: args.observedAt,
      },
    },
    state: { lastObservedAt: args.observedAt },
    tags: [args.tag],
    visibility: "owner_only" as const,
  };
}

function assertSafeActionBundle(bundle: ActionBundle): void {
  for (const item of bundle.items) {
    if (
      item.effectClass !== "read_only" &&
      item.effectClass !== "internal_reversible" &&
      item.approvalRequirement === "none"
    ) {
      throw new SchoolSourceFactError(
        "Consequential action bundle items require typed approval",
        "SCHOOL_INVALID_CONTRACT",
        {
          bundleId: bundle.id,
          itemId: item.id,
          effectClass: item.effectClass,
        },
      );
    }
    if (item.state !== "proposed" && item.state !== "blocked") {
      throw new SchoolSourceFactError(
        "Source ingestion may only persist proposed or blocked actions",
        "SCHOOL_INVALID_CONTRACT",
        { bundleId: bundle.id, itemId: item.id, state: item.state },
      );
    }
  }
}

export class SchoolSourceFactRepository {
  constructor(
    private readonly agentId: string,
    private readonly entityStore: EntityStore,
    private readonly relationshipStore: RelationshipStore,
  ) {}

  async putArtifact(
    artifactInput: SourceArtifactInput,
  ): Promise<SourceArtifact> {
    const input = normalizeSourceArtifactInput(artifactInput);
    if (sha256(input.untrustedContent) !== input.contentSha256) {
      throw new SchoolSourceFactError(
        "Source artifact content does not match contentSha256",
        "SCHOOL_INVALID_CONTRACT",
        { stableReference: input.stableReference },
      );
    }
    const id = stableSchoolId("src", {
      agentId: this.agentId,
      kind: input.kind,
      sourceId: input.sourceId,
      stableReference: input.stableReference,
      snapshotReference: input.snapshotReference,
      contentSha256: input.contentSha256,
    });
    const artifact: SourceArtifact = {
      ...input,
      id,
      createdAt: input.retrievedAt,
    };
    const existing = await this.entityStore.get(id);
    if (existing) {
      const persisted = artifactFromEntity(existing);
      if (canonicalSchoolJson(persisted) !== canonicalSchoolJson(artifact)) {
        return invalidPersisted(
          "Content-addressed source artifact changed after persistence",
          { artifactId: id },
        );
      }
      return persisted;
    }
    const entity = await this.entityStore.upsert(
      entityInput({
        id,
        type: "concept",
        name: `Source ${input.kind}: ${input.stableReference}`,
        tag: SOURCE_ARTIFACT_TAG,
        attributeKey: SOURCE_ARTIFACT_ATTRIBUTE,
        contract: artifact,
        confidence: 1,
        evidence: [input.snapshotReference],
        observedAt: input.observedAt,
      }),
    );
    return artifactFromEntity(entity);
  }

  async getArtifact(id: string): Promise<SourceArtifact | null> {
    const entity = await this.entityStore.get(id);
    if (!entity) return null;
    if (!entity.tags.includes(SOURCE_ARTIFACT_TAG)) {
      return invalidPersisted(
        "Requested graph entity is not a source artifact",
        {
          entityId: id,
        },
      );
    }
    return artifactFromEntity(entity);
  }

  async putFact(
    artifact: SourceArtifact,
    candidateInput: SourceFactCandidate,
  ): Promise<SourceFact> {
    const candidate = normalizeSourceFactCandidate(candidateInput);
    const revisionSha256 = sourceFactRevisionSha256(artifact.id, candidate);
    const id = stableSchoolId("fact", {
      agentId: this.agentId,
      artifactId: artifact.id,
      stableFactKey: candidate.stableFactKey,
      revisionSha256,
    });
    const fact: SourceFact = {
      ...candidate,
      id,
      artifactId: artifact.id,
      revisionSha256,
      createdAt: artifact.retrievedAt,
    };
    const existing = await this.entityStore.get(id);
    if (existing) {
      const persisted = factFromEntity(existing);
      if (canonicalSchoolJson(persisted) !== canonicalSchoolJson(fact)) {
        return invalidPersisted(
          "Content-addressed source fact changed after persistence",
          { factId: id },
        );
      }
      return persisted;
    }
    const entity = await this.entityStore.upsert(
      entityInput({
        id,
        type: "concept",
        name: `Source fact: ${candidate.stableFactKey}`,
        tag: SOURCE_FACT_TAG,
        attributeKey: SOURCE_FACT_ATTRIBUTE,
        contract: {
          id,
          artifactId: artifact.id,
          revisionSha256,
          createdAt: artifact.retrievedAt,
          candidate,
        },
        confidence: candidate.confidence,
        evidence: [artifact.id],
        observedAt: artifact.observedAt,
      }),
    );
    const persisted = factFromEntity(entity);
    await this.ensureRelationship({
      fromEntityId: persisted.id,
      toEntityId: artifact.id,
      type: "derived_from_source_artifact",
      metadata: {
        stableReference: artifact.stableReference,
        snapshotReference: artifact.snapshotReference,
      },
      evidence: [artifact.id],
      confidence: 1,
      occurredAt: artifact.observedAt,
    });
    for (const subjectEntityId of persisted.subjectEntityIds) {
      await this.ensureRelationship({
        fromEntityId: persisted.id,
        toEntityId: subjectEntityId,
        type: "applies_to_child",
        metadata: { stableFactKey: persisted.stableFactKey },
        evidence: [persisted.id],
        confidence: persisted.confidence,
        occurredAt: artifact.observedAt,
      });
    }
    return persisted;
  }

  async getFact(id: string): Promise<SourceFact | null> {
    const entity = await this.entityStore.get(id);
    if (!entity) return null;
    if (!entity.tags.includes(SOURCE_FACT_TAG)) {
      return invalidPersisted("Requested graph entity is not a source fact", {
        entityId: id,
      });
    }
    return factFromEntity(entity);
  }

  async listFacts(stableFactKey?: string): Promise<SourceFact[]> {
    const entities = await this.entityStore.list({ tag: SOURCE_FACT_TAG });
    return entities
      .map(factFromEntity)
      .filter(
        (fact) =>
          stableFactKey === undefined || fact.stableFactKey === stableFactKey,
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
  }

  async putResponsibility(
    inputValue: ResponsibilityAssignmentInput,
    createdAt: string,
  ): Promise<ResponsibilityAssignment> {
    const input = normalizeResponsibilityAssignmentInput(inputValue);
    const id = stableSchoolId("resp", {
      agentId: this.agentId,
      input,
    });
    const assignment: ResponsibilityAssignment = { ...input, id, createdAt };
    const existing = await this.entityStore.get(id);
    if (existing) {
      return responsibilityFromEntity(existing);
    }
    const entity = await this.entityStore.upsert(
      entityInput({
        id,
        type: "project",
        name: `Responsibility: ${input.subjectKey}`,
        tag: RESPONSIBILITY_TAG,
        attributeKey: RESPONSIBILITY_ATTRIBUTE,
        contract: assignment,
        confidence: 1,
        evidence: input.acceptedBy,
        observedAt: createdAt,
      }),
    );
    const persisted = responsibilityFromEntity(entity);
    const owners = [
      ["conception", persisted.conceptionOwnerId],
      ["planning", persisted.planningOwnerId],
      ["execution", persisted.executionOwnerId],
      ["monitoring", persisted.monitoringOwnerId],
    ] as const;
    for (const [phase, ownerId] of owners) {
      await this.ensureRelationship({
        fromEntityId: ownerId,
        toEntityId: persisted.id,
        type: `owns_${phase}_for`,
        metadata: {
          phase,
          minimumStandard: persisted.minimumStandard,
          startsAt: persisted.startsAt,
          endsAt: persisted.endsAt,
        },
        evidence: persisted.acceptedBy,
        confidence: 1,
        occurredAt: createdAt,
      });
    }
    return persisted;
  }

  async getResponsibility(
    id: string,
  ): Promise<ResponsibilityAssignment | null> {
    const entity = await this.entityStore.get(id);
    if (!entity) return null;
    if (!entity.tags.includes(RESPONSIBILITY_TAG)) {
      return invalidPersisted(
        "Requested graph entity is not a responsibility assignment",
        { entityId: id },
      );
    }
    return responsibilityFromEntity(entity);
  }

  async putActionBundle(
    bundle: ActionBundle,
    supersedesBundleIds: readonly string[],
  ): Promise<ActionBundle> {
    assertSafeActionBundle(bundle);
    const expectedId = stableSchoolId("bundle", {
      agentId: this.agentId,
      noticeKey: bundle.noticeKey,
      sourceFactIds: [...bundle.sourceFactIds].sort(),
      childEntityId: bundle.childEntityId,
      revision: bundle.revision,
      state: bundle.state,
      items: bundle.items,
      responsibilityAssignmentId: bundle.responsibilityAssignmentId,
    });
    if (bundle.id !== expectedId) {
      throw new SchoolSourceFactError(
        "Action bundle id does not match its immutable content",
        "SCHOOL_INVALID_CONTRACT",
        { bundleId: bundle.id, expectedId },
      );
    }
    const existing = await this.entityStore.get(bundle.id);
    let persisted: ActionBundle;
    if (existing) {
      persisted = actionBundleFromEntity(existing);
    } else {
      const entity = await this.entityStore.upsert(
        entityInput({
          id: bundle.id,
          type: "project",
          name: `Action bundle: ${bundle.noticeKey}`,
          tag: ACTION_BUNDLE_TAG,
          attributeKey: ACTION_BUNDLE_ATTRIBUTE,
          contract: bundle,
          confidence: 1,
          evidence: bundle.sourceFactIds,
          observedAt: bundle.createdAt,
        }),
      );
      persisted = actionBundleFromEntity(entity);
    }
    for (const factId of persisted.sourceFactIds) {
      await this.ensureRelationship({
        fromEntityId: factId,
        toEntityId: persisted.id,
        type: "influenced_action_bundle",
        metadata: { noticeKey: persisted.noticeKey },
        evidence: [factId],
        confidence: 1,
        occurredAt: persisted.createdAt,
      });
    }
    for (const supersededId of Array.from(new Set(supersedesBundleIds))) {
      if (supersededId === persisted.id) continue;
      await this.ensureRelationship({
        fromEntityId: persisted.id,
        toEntityId: supersededId,
        type: "supersedes_action_bundle",
        metadata: { noticeKey: persisted.noticeKey },
        evidence: persisted.sourceFactIds,
        confidence: 1,
        occurredAt: persisted.createdAt,
      });
    }
    if (persisted.responsibilityAssignmentId) {
      await this.ensureRelationship({
        fromEntityId: persisted.responsibilityAssignmentId,
        toEntityId: persisted.id,
        type: "governs_action_bundle",
        metadata: { noticeKey: persisted.noticeKey },
        evidence: persisted.sourceFactIds,
        confidence: 1,
        occurredAt: persisted.createdAt,
      });
    }
    return persisted;
  }

  async listActionBundles(noticeKey?: string): Promise<ActionBundle[]> {
    const entities = await this.entityStore.list({ tag: ACTION_BUNDLE_TAG });
    return entities
      .map(actionBundleFromEntity)
      .filter(
        (bundle) => noticeKey === undefined || bundle.noticeKey === noticeKey,
      )
      .sort(
        (left, right) =>
          left.revision - right.revision || left.id.localeCompare(right.id),
      );
  }

  async listRelationships(filter?: {
    fromEntityId?: string;
    toEntityId?: string;
    type?: string | string[];
  }): Promise<Relationship[]> {
    return this.relationshipStore.list(filter);
  }

  async linkFacts(args: {
    fromFactId: string;
    toFactId: string;
    type: "supersedes_source_fact" | "contradicts_source_fact";
    occurredAt: string;
  }): Promise<Relationship> {
    return this.ensureRelationship({
      fromEntityId: args.fromFactId,
      toEntityId: args.toFactId,
      type: args.type,
      metadata: {},
      evidence: [args.fromFactId, args.toFactId],
      confidence: 1,
      occurredAt: args.occurredAt,
    });
  }

  private async ensureRelationship(input: {
    fromEntityId: string;
    toEntityId: string;
    type: string;
    metadata: Record<string, unknown>;
    evidence: string[];
    confidence: number;
    occurredAt: string;
  }): Promise<Relationship> {
    const relationshipId = stableSchoolId("rel", {
      agentId: this.agentId,
      fromEntityId: input.fromEntityId,
      toEntityId: input.toEntityId,
      type: input.type,
    });
    const existing = await this.relationshipStore.get(relationshipId);
    if (existing) {
      if (
        existing.fromEntityId !== input.fromEntityId ||
        existing.toEntityId !== input.toEntityId ||
        existing.type !== input.type
      ) {
        return invalidPersisted(
          "Content-addressed relationship changed after persistence",
          { relationshipId },
        );
      }
      return existing;
    }
    return this.relationshipStore.upsert({
      relationshipId,
      fromEntityId: input.fromEntityId,
      toEntityId: input.toEntityId,
      type: input.type,
      metadata: input.metadata,
      state: {
        lastObservedAt: input.occurredAt,
        lastInteractionAt: input.occurredAt,
        interactionCount: 1,
      },
      evidence: [...input.evidence],
      confidence: input.confidence,
      source: "import",
      status: "active",
    });
  }
}

export function actionBundleId(args: {
  agentId: string;
  noticeKey: string;
  sourceFactIds: string[];
  childEntityId: string | null;
  revision: number;
  state: ActionBundle["state"];
  items: ActionBundleItem[];
  responsibilityAssignmentId: string | null;
}): string {
  return stableSchoolId("bundle", {
    agentId: args.agentId,
    noticeKey: args.noticeKey,
    sourceFactIds: [...args.sourceFactIds].sort(),
    childEntityId: args.childEntityId,
    revision: args.revision,
    state: args.state,
    items: args.items,
    responsibilityAssignmentId: args.responsibilityAssignmentId,
  });
}
