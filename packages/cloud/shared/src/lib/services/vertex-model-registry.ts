// Coordinates cloud service vertex model registry behavior behind route handlers.

import { randomUUID } from "node:crypto";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { type DbTransaction, dbRead, dbWrite } from "../../db/client";
import {
  type VertexModelAssignmentRecord,
  type VertexTunedModelRecord,
  type VertexTuningJobRecord,
  vertexModelAssignments,
  vertexTunedModels,
  vertexTuningJobs,
} from "../../db/schemas";
import type { ModelPreferenceKey, ModelPreferences } from "../eliza/model-preferences";
import { mergeModelPreferences, normalizeModelPreferences } from "../eliza/model-preferences";
import { ObjectNamespaces } from "../storage/object-namespace";
import {
  buildObjectFieldKey,
  hydrateJsonField,
  ObjectStorageLifecycleError,
  offloadJsonField,
} from "../storage/object-store";
import { isValidUUID } from "../utils/validation";
import {
  buildVertexModelPreferencePatch,
  getTuningJobStatus,
  type TuningJob,
  type VertexTuningScope,
  type VertexTuningSlot,
} from "./vertex-tuning";
import {
  isTerminalVertexState,
  requireVertexJobName,
  requireVertexObservation,
  vertexObservationError,
  vertexPayloadDigest,
  vertexTimestampVersion,
  vertexTunedResources,
} from "./vertex-tuning-observation";

type ViewerScope = {
  organizationId?: string;
  userId?: string;
};

type AssignmentScopeOwner = {
  scope: VertexTuningScope;
  organizationId?: string;
  userId?: string;
};

type NormalizedScopeOwner =
  | { scope: "global"; organizationId?: undefined; userId?: undefined }
  | { scope: "organization"; organizationId: string; userId?: undefined }
  | { scope: "user"; organizationId: string; userId: string };
type SqlCondition = ReturnType<typeof eq>;

export interface RecordSubmittedVertexTuningJobInput extends AssignmentScopeOwner {
  vertexJobName: string;
  projectId: string;
  region: string;
  displayName: string;
  baseModel: string;
  slot: VertexTuningSlot;
  createdByUserId?: string;
  trainingDataPath: string;
  validationDataPath?: string;
  trainingDataUri?: string;
  validationDataUri?: string;
  recommendedModelId?: string;
  remoteJob: TuningJob;
  metadata?: Record<string, unknown>;
}

export interface VertexTuningJobRecordWithModel {
  job: VertexTuningJobRecord;
  tunedModel?: VertexTunedModelRecord;
}

export interface VertexModelAssignmentWithModel {
  assignment: VertexModelAssignmentRecord;
  tunedModel: VertexTunedModelRecord;
}

export interface ResolvedModelPreferences {
  modelPreferences?: ModelPreferences;
  assignments: VertexModelAssignmentWithModel[];
  sources: Partial<Record<ModelPreferenceKey, VertexModelAssignmentWithModel>>;
}

function normalizeScopeOwner(input: AssignmentScopeOwner): NormalizedScopeOwner {
  const organizationId = input.organizationId?.trim();
  const userId = input.userId?.trim();

  switch (input.scope) {
    case "global":
      return { scope: "global", organizationId: undefined, userId: undefined };
    case "organization":
      if (!organizationId || !isValidUUID(organizationId)) {
        throw new Error("organizationId is required for organization-scoped tuned models");
      }
      return { scope: "organization", organizationId, userId: undefined };
    case "user":
      if (!organizationId || !isValidUUID(organizationId)) {
        throw new Error("organizationId is required for user-scoped tuned models");
      }
      if (!userId || !isValidUUID(userId)) {
        throw new Error("userId is required for user-scoped tuned models");
      }
      return { scope: "user", organizationId, userId };
  }
}

function allConditions(...conditions: SqlCondition[]): SqlCondition {
  const condition = and(...conditions);
  if (!condition) {
    throw new Error("Expected at least one SQL condition");
  }
  return condition;
}

function anyCondition(conditions: [SqlCondition, ...SqlCondition[]]): SqlCondition {
  if (conditions.length === 1) {
    return conditions[0];
  }
  const condition = or(...conditions);
  if (!condition) {
    throw new Error("Expected at least one SQL condition");
  }
  return condition;
}

function buildVisibilityCondition(viewer: ViewerScope) {
  const clauses: [SqlCondition, ...SqlCondition[]] = [eq(vertexTuningJobs.scope, "global")];

  if (viewer.organizationId && isValidUUID(viewer.organizationId)) {
    clauses.push(
      allConditions(
        eq(vertexTuningJobs.scope, "organization"),
        eq(vertexTuningJobs.organization_id, viewer.organizationId),
      ),
    );
  }

  if (viewer.userId && isValidUUID(viewer.userId)) {
    clauses.push(
      allConditions(
        eq(vertexTuningJobs.scope, "user"),
        eq(vertexTuningJobs.user_id, viewer.userId),
      ),
    );
  }

  return anyCondition(clauses);
}

function buildModelVisibilityCondition(viewer: ViewerScope) {
  const clauses: [SqlCondition, ...SqlCondition[]] = [eq(vertexTunedModels.source_scope, "global")];

  if (viewer.organizationId && isValidUUID(viewer.organizationId)) {
    clauses.push(
      allConditions(
        eq(vertexTunedModels.source_scope, "organization"),
        eq(vertexTunedModels.organization_id, viewer.organizationId),
      ),
    );
  }

  if (viewer.userId && isValidUUID(viewer.userId)) {
    clauses.push(
      allConditions(
        eq(vertexTunedModels.source_scope, "user"),
        eq(vertexTunedModels.user_id, viewer.userId),
      ),
    );
  }

  return anyCondition(clauses);
}

function buildAssignmentVisibilityCondition(viewer: ViewerScope) {
  const clauses: [SqlCondition, ...SqlCondition[]] = [eq(vertexModelAssignments.scope, "global")];

  if (viewer.organizationId && isValidUUID(viewer.organizationId)) {
    clauses.push(
      allConditions(
        eq(vertexModelAssignments.scope, "organization"),
        eq(vertexModelAssignments.organization_id, viewer.organizationId),
      ),
    );
  }

  if (viewer.userId && isValidUUID(viewer.userId)) {
    clauses.push(
      allConditions(
        eq(vertexModelAssignments.scope, "user"),
        eq(vertexModelAssignments.user_id, viewer.userId),
      ),
    );
  }

  return anyCondition(clauses);
}

function buildActiveAssignmentCondition(
  owner: NormalizedScopeOwner,
  slot: VertexTuningSlot,
): SqlCondition {
  switch (owner.scope) {
    case "global":
      return allConditions(
        eq(vertexModelAssignments.scope, "global"),
        eq(vertexModelAssignments.slot, slot),
        eq(vertexModelAssignments.is_active, true),
      );
    case "organization":
      return allConditions(
        eq(vertexModelAssignments.scope, "organization"),
        eq(vertexModelAssignments.organization_id, owner.organizationId),
        eq(vertexModelAssignments.slot, slot),
        eq(vertexModelAssignments.is_active, true),
      );
    case "user":
      return allConditions(
        eq(vertexModelAssignments.scope, "user"),
        eq(vertexModelAssignments.organization_id, owner.organizationId),
        eq(vertexModelAssignments.user_id, owner.userId),
        eq(vertexModelAssignments.slot, slot),
        eq(vertexModelAssignments.is_active, true),
      );
  }
}

function getScopePriority(scope: VertexTuningScope): number {
  switch (scope) {
    case "global":
      return 0;
    case "organization":
      return 1;
    case "user":
      return 2;
  }
}

function getRecommendedModelId(remoteJob: TuningJob, fallbackDisplayName: string): string {
  const resources = vertexTunedResources(remoteJob);
  return (
    resources.endpoint ??
    resources.model ??
    (remoteJob.tunedModelDisplayName?.trim() || fallbackDisplayName)
  );
}

async function hydrateVertexTuningJob(job: VertexTuningJobRecord): Promise<VertexTuningJobRecord> {
  const payload = await hydrateJsonField<Record<string, unknown>>({
    storage: job.last_remote_payload_storage,
    key: job.last_remote_payload_key,
    inlineValue: job.last_remote_payload,
    strict: true,
  });
  const remote = requireVertexObservation(payload, job.vertex_job_name);
  const identity = requireVertexJobName(remote.name);
  if (
    identity.region !== job.region ||
    remote.state !== job.status ||
    (job.provider_update_time !== null &&
      job.provider_update_time !== vertexTimestampVersion(remote.updateTime)) ||
    (job.provider_payload_digest !== null &&
      job.provider_payload_digest !== vertexPayloadDigest(remote))
  ) {
    return vertexObservationError(
      "VERTEX_RECEIPT_INTEGRITY",
      "Stored Vertex observation differs from its authority",
    );
  }
  return { ...job, last_remote_payload: remote };
}

type PayloadFields = Pick<
  VertexTuningJobRecord,
  "last_remote_payload" | "last_remote_payload_storage" | "last_remote_payload_key"
>;
async function prepareRemotePayloadFields(params: {
  organizationId?: string;
  objectId: string;
  createdAt: Date;
  remoteJob: TuningJob;
}): Promise<PayloadFields> {
  const digest = vertexPayloadDigest(params.remoteJob);
  const identity = {
    namespace: ObjectNamespaces.VertexTuningPayloads,
    organizationId: params.organizationId ?? "global",
    objectId: vertexPayloadDigest(params.objectId),
    field: "last_remote_payload",
    createdAt: params.createdAt,
    version: digest,
  };
  try {
    const payload = await offloadJsonField<Record<string, unknown>>({
      ...identity,
      value: params.remoteJob,
      inlineValueWhenOffloaded: {},
      immutable: true,
    });
    return {
      last_remote_payload: payload.value ?? {},
      last_remote_payload_storage: payload.storage,
      last_remote_payload_key: payload.key,
    };
  } catch (error) {
    if (
      !(error instanceof ObjectStorageLifecycleError) ||
      error.code !== "OBJECT_STORAGE_IMMUTABLE_CONFLICT"
    )
      throw error;
    const key = buildObjectFieldKey({ ...identity, extension: "json" });
    const retained = await hydrateJsonField<Record<string, unknown>>({
      storage: "r2",
      key,
      inlineValue: null,
      strict: true,
    });
    if (vertexPayloadDigest(retained) !== digest) {
      return vertexObservationError(
        "VERTEX_RECEIPT_INTEGRITY",
        "Immutable Vertex payload key contains different content",
      );
    }
    return {
      last_remote_payload: {},
      last_remote_payload_storage: "r2",
      last_remote_payload_key: key,
    };
  }
}

function sameJobOwner(a: VertexTuningJobRecord, b: VertexTuningJobRecord): boolean {
  return (
    a.vertex_job_name === b.vertex_job_name &&
    a.project_id === b.project_id &&
    a.region === b.region &&
    a.scope === b.scope &&
    a.organization_id === b.organization_id &&
    a.user_id === b.user_id &&
    a.slot === b.slot &&
    a.base_model === b.base_model
  );
}

function sameStoredReceipt(
  current: VertexTuningJobRecord,
  snapshot: VertexTuningJobRecord,
): boolean {
  return (
    current.provider_update_time !== null &&
    current.observation_revision === snapshot.observation_revision &&
    current.provider_update_time === snapshot.provider_update_time &&
    current.provider_payload_digest === snapshot.provider_payload_digest &&
    current.status === snapshot.status &&
    current.last_remote_payload_storage === snapshot.last_remote_payload_storage &&
    current.last_remote_payload_key === snapshot.last_remote_payload_key &&
    (current.last_remote_payload_storage === "r2" ||
      vertexPayloadDigest(current.last_remote_payload) === current.provider_payload_digest)
  );
}

function sameSubmission(
  job: VertexTuningJobRecord,
  input: RecordSubmittedVertexTuningJobInput,
  owner: NormalizedScopeOwner,
): boolean {
  return (
    job.vertex_job_name === input.vertexJobName &&
    job.project_id === input.projectId &&
    job.region === input.region &&
    job.scope === owner.scope &&
    job.organization_id === (owner.organizationId ?? null) &&
    job.user_id === (owner.userId ?? null) &&
    job.slot === input.slot &&
    job.base_model === input.baseModel &&
    job.display_name === input.displayName &&
    job.created_by_user_id === (input.createdByUserId ?? null) &&
    job.training_data_path === input.trainingDataPath &&
    job.validation_data_path === (input.validationDataPath ?? null) &&
    job.training_data_uri === (input.trainingDataUri ?? null) &&
    job.validation_data_uri === (input.validationDataUri ?? null)
  );
}

export class VertexModelRegistryService {
  async recordSubmittedJob(
    input: RecordSubmittedVertexTuningJobInput,
  ): Promise<VertexTuningJobRecordWithModel> {
    const owner = normalizeScopeOwner(input);
    const remote = requireVertexObservation(input.remoteJob, input.vertexJobName);
    const identity = requireVertexJobName(remote.name);
    // This trusted coordinator supplies the provider-assigned name. projectId
    // is immutable request provenance, not proof of ID/number alias equality.
    if (identity.region !== input.region)
      return vertexObservationError(
        "VERTEX_OBSERVATION_IDENTITY",
        "Submitted Vertex job differs from its original region",
      );
    if (
      input.recommendedModelId &&
      input.recommendedModelId.trim() !== getRecommendedModelId(remote, input.displayName)
    )
      return vertexObservationError(
        "VERTEX_SUBMISSION_CONFLICT",
        "Requested model differs from the provider resource",
      );
    const fields = await prepareRemotePayloadFields({
      organizationId: owner.organizationId,
      objectId: input.vertexJobName,
      createdAt: new Date(remote.createTime),
      remoteJob: remote,
    });
    const result = await dbWrite.transaction(async (tx) => {
      const recommendedModelId = getRecommendedModelId(remote, input.displayName);
      const resources = vertexTunedResources(remote);
      const [created] = await tx
        .insert(vertexTuningJobs)
        .values({
          id: randomUUID(),
          vertex_job_name: input.vertexJobName,
          project_id: input.projectId,
          region: input.region,
          display_name: input.displayName,
          base_model: input.baseModel,
          slot: input.slot,
          scope: owner.scope,
          organization_id: owner.organizationId,
          user_id: owner.userId,
          created_by_user_id: input.createdByUserId,
          training_data_path: input.trainingDataPath,
          validation_data_path: input.validationDataPath,
          training_data_uri: input.trainingDataUri,
          validation_data_uri: input.validationDataUri,
          recommended_model_id: recommendedModelId,
          tuned_model_display_name: remote.tunedModelDisplayName,
          tuned_model_endpoint_name: resources.endpoint,
          status: remote.state,
          error_code: remote.error?.code,
          error_message: remote.error?.message,
          model_preference_patch: buildVertexModelPreferencePatch({
            slot: input.slot,
            tunedModelId: recommendedModelId,
            scope: owner.scope,
            ownerId: owner.userId ?? owner.organizationId,
          }).modelPreferences as Record<string, string>,
          ...fields,
          provider_update_time: vertexTimestampVersion(remote.updateTime),
          provider_payload_digest: vertexPayloadDigest(remote),
          observation_revision: 1,
          completed_provider_time:
            isTerminalVertexState(remote.state) && remote.endTime
              ? vertexTimestampVersion(remote.endTime)
              : null,
          metadata: input.metadata ?? {},
          completed_at: isTerminalVertexState(remote.state) ? sql`clock_timestamp()` : null,
          created_at: new Date(remote.createTime),
          updated_at: new Date(remote.updateTime),
        })
        .onConflictDoNothing({ target: vertexTuningJobs.vertex_job_name })
        .returning();
      if (created)
        return {
          job: created,
          tunedModel:
            remote.state === "JOB_STATE_SUCCEEDED"
              ? await this.publishTunedModel(tx, created, remote)
              : undefined,
        };
      const [current] = await tx
        .select()
        .from(vertexTuningJobs)
        .where(eq(vertexTuningJobs.vertex_job_name, input.vertexJobName))
        .for("update");
      if (!current || !sameSubmission(current, input, owner))
        return vertexObservationError(
          "VERTEX_SUBMISSION_CONFLICT",
          "Vertex job is already bound to another submission",
        );
      return this.applyObservation(tx, current, remote, fields);
    });
    return { ...result, job: await hydrateVertexTuningJob(result.job) };
  }

  async syncJobStatus(params: {
    jobId?: string;
    vertexJobName?: string;
    viewer: ViewerScope;
  }): Promise<VertexTuningJobRecordWithModel | null> {
    const visibility = buildVisibilityCondition(params.viewer);
    const lookup = params.jobId
      ? eq(vertexTuningJobs.id, params.jobId)
      : params.vertexJobName
        ? eq(vertexTuningJobs.vertex_job_name, params.vertexJobName)
        : null;
    if (!lookup) return null;
    const [job] = await dbWrite
      .select()
      .from(vertexTuningJobs)
      .where(and(lookup, visibility))
      .limit(1);
    if (!job) return null;
    const identity = requireVertexJobName(job.vertex_job_name);
    // Refresh the exact saved provider name; project_id retains the original
    // request spelling and remains part of the owner CAS below.
    if (identity.region !== job.region)
      return vertexObservationError(
        "VERTEX_RECEIPT_INTEGRITY",
        "Stored Vertex job has inconsistent region authority",
      );
    // Read the immutable current generation before taking the SQL lock. Reuse
    // it only if the locked receipt still matches; legacy/changed rows recover
    // their own current receipt instead.
    let snapshot: VertexTuningJobRecord;
    try {
      snapshot = await hydrateVertexTuningJob(job);
    } catch (error) {
      const [stillPresent] = await dbWrite
        .select({ id: vertexTuningJobs.id })
        .from(vertexTuningJobs)
        .where(and(eq(vertexTuningJobs.id, job.id), visibility))
        .limit(1);
      if (!stillPresent) return null;
      throw error;
    }
    const remote = requireVertexObservation(
      await getTuningJobStatus(job.vertex_job_name),
      job.vertex_job_name,
    );
    const fields = await prepareRemotePayloadFields({
      organizationId: job.organization_id ?? undefined,
      objectId: job.vertex_job_name,
      createdAt: new Date(remote.createTime),
      remoteJob: remote,
    });
    const result = await dbWrite.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(vertexTuningJobs)
        .where(and(eq(vertexTuningJobs.id, job.id), visibility))
        .for("update");
      if (!current) return null;
      if (!sameJobOwner(current, job))
        return vertexObservationError(
          "VERTEX_OBSERVATION_IDENTITY",
          "Vertex job authority changed while refreshing",
        );
      return this.applyObservation(tx, current, remote, fields, snapshot);
    });
    if (!result) return null;
    return { ...result, job: await hydrateVertexTuningJob(result.job) };
  }

  private async applyObservation(
    tx: DbTransaction,
    current: VertexTuningJobRecord,
    remote: TuningJob,
    fields: PayloadFields,
    snapshot?: VertexTuningJobRecord,
  ): Promise<VertexTuningJobRecordWithModel> {
    const retained =
      snapshot && sameStoredReceipt(current, snapshot)
        ? snapshot
        : await hydrateVertexTuningJob(current);
    const previous = requireVertexObservation(
      retained.last_remote_payload,
      current.vertex_job_name,
    );
    const oldVersion = vertexTimestampVersion(previous.updateTime);
    const version = vertexTimestampVersion(remote.updateTime);
    const digest = vertexPayloadDigest(remote);
    if (vertexTimestampVersion(previous.createTime) !== vertexTimestampVersion(remote.createTime))
      return vertexObservationError(
        "VERTEX_OBSERVATION_IDENTITY",
        "Vertex creation identity changed",
      );
    if (version === oldVersion && vertexPayloadDigest(previous) !== digest)
      return vertexObservationError(
        "VERTEX_OBSERVATION_CONFLICT",
        "Equal Vertex update times have different observations",
      );
    if (version < oldVersion || (version === oldVersion && current.provider_update_time !== null)) {
      return {
        job: current,
        tunedModel:
          current.status === "JOB_STATE_SUCCEEDED"
            ? await this.publishTunedModel(tx, current, previous)
            : undefined,
      };
    }
    const oldResources = vertexTunedResources(previous);
    const resources = vertexTunedResources(remote);
    if (
      isTerminalVertexState(previous.state) &&
      (remote.state !== previous.state ||
        resources.endpoint !== oldResources.endpoint ||
        resources.model !== oldResources.model)
    )
      return vertexObservationError(
        "VERTEX_TERMINAL_CONFLICT",
        "Vertex terminal state or model identity changed",
      );
    if (
      previous.state === "JOB_STATE_CANCELLING" &&
      ![
        "JOB_STATE_CANCELLING",
        "JOB_STATE_SUCCEEDED",
        "JOB_STATE_FAILED",
        "JOB_STATE_CANCELLED",
      ].includes(remote.state)
    )
      return vertexObservationError(
        "VERTEX_OBSERVATION_CONFLICT",
        "Vertex cancellation cannot return to a running state",
      );
    const modelId = getRecommendedModelId(remote, current.display_name);
    const [updated] = await tx
      .update(vertexTuningJobs)
      .set({
        status: remote.state,
        recommended_model_id: modelId,
        tuned_model_display_name: remote.tunedModelDisplayName ?? null,
        tuned_model_endpoint_name: resources.endpoint,
        error_code: remote.error?.code ?? null,
        error_message: remote.error?.message ?? null,
        model_preference_patch: buildVertexModelPreferencePatch({
          slot: current.slot,
          tunedModelId: modelId,
          scope: current.scope,
          ownerId: current.user_id ?? current.organization_id ?? undefined,
        }).modelPreferences as Record<string, string>,
        ...fields,
        provider_update_time: version,
        provider_payload_digest: digest,
        observation_revision: current.observation_revision + 1,
        completed_provider_time:
          current.completed_provider_time ??
          (isTerminalVertexState(previous.state) && previous.endTime
            ? vertexTimestampVersion(previous.endTime)
            : isTerminalVertexState(remote.state) && remote.endTime
              ? vertexTimestampVersion(remote.endTime)
              : null),
        ...(current.completed_at === null && isTerminalVertexState(remote.state)
          ? { completed_at: sql`clock_timestamp()` }
          : {}),
        updated_at: new Date(remote.updateTime),
      })
      .where(eq(vertexTuningJobs.id, current.id))
      .returning();
    if (!updated)
      return vertexObservationError(
        "VERTEX_OBSERVATION_CONFLICT",
        "Vertex job disappeared while locked",
      );
    return {
      job: updated,
      tunedModel:
        remote.state === "JOB_STATE_SUCCEEDED"
          ? await this.publishTunedModel(tx, updated, remote)
          : undefined,
    };
  }

  async listVisibleJobs(
    viewer: ViewerScope,
    filters: {
      scope?: VertexTuningScope;
      slot?: VertexTuningSlot;
      status?: TuningJob["state"];
      limit?: number;
    } = {},
  ): Promise<VertexTuningJobRecord[]> {
    const conditions = [buildVisibilityCondition(viewer)];

    if (filters.scope) {
      conditions.push(eq(vertexTuningJobs.scope, filters.scope));
    }
    if (filters.slot) {
      conditions.push(eq(vertexTuningJobs.slot, filters.slot));
    }
    if (filters.status) {
      conditions.push(eq(vertexTuningJobs.status, filters.status));
    }

    const jobs = await dbRead.query.vertexTuningJobs.findMany({
      where: and(...conditions),
      orderBy: [desc(vertexTuningJobs.created_at)],
      limit: filters.limit ?? 100,
    });
    const hydrated: VertexTuningJobRecord[] = [];
    for (let start = 0; start < jobs.length; start += 8) {
      hydrated.push(
        ...(await Promise.all(jobs.slice(start, start + 8).map(hydrateVertexTuningJob))),
      );
    }
    return hydrated;
  }

  async listVisibleTunedModels(
    viewer: ViewerScope,
    filters: {
      scope?: VertexTuningScope;
      slot?: VertexTuningSlot;
      limit?: number;
    } = {},
  ): Promise<
    Array<
      VertexTunedModelRecord & {
        activeAssignments: VertexModelAssignmentRecord[];
      }
    >
  > {
    const conditions = [buildModelVisibilityCondition(viewer)];

    if (filters.scope) {
      conditions.push(eq(vertexTunedModels.source_scope, filters.scope));
    }
    if (filters.slot) {
      conditions.push(eq(vertexTunedModels.slot, filters.slot));
    }

    const models = await dbRead.query.vertexTunedModels.findMany({
      where: and(...conditions),
      orderBy: [desc(vertexTunedModels.created_at)],
      limit: filters.limit ?? 100,
    });

    const visibleAssignments = await this.listVisibleAssignments(viewer, {
      scope: filters.scope,
      slot: filters.slot,
      activeOnly: true,
      limit: filters.limit ? filters.limit * 4 : undefined,
    });

    const assignmentsByModelId = new Map<string, VertexModelAssignmentRecord[]>();
    for (const item of visibleAssignments) {
      const existing = assignmentsByModelId.get(item.tunedModel.id) ?? [];
      existing.push(item.assignment);
      assignmentsByModelId.set(item.tunedModel.id, existing);
    }

    return models.map((model) => ({
      ...model,
      activeAssignments: assignmentsByModelId.get(model.id) ?? [],
    }));
  }

  async listVisibleAssignments(
    viewer: ViewerScope,
    filters: {
      scope?: VertexTuningScope;
      slot?: VertexTuningSlot;
      activeOnly?: boolean;
      limit?: number;
    } = {},
  ): Promise<VertexModelAssignmentWithModel[]> {
    const conditions = [buildAssignmentVisibilityCondition(viewer)];

    if (filters.scope) {
      conditions.push(eq(vertexModelAssignments.scope, filters.scope));
    }
    if (filters.slot) {
      conditions.push(eq(vertexModelAssignments.slot, filters.slot));
    }
    if (filters.activeOnly !== false) {
      conditions.push(eq(vertexModelAssignments.is_active, true));
    }

    const rows = await dbRead
      .select({
        assignment: vertexModelAssignments,
        tunedModel: vertexTunedModels,
      })
      .from(vertexModelAssignments)
      .innerJoin(vertexTunedModels, eq(vertexModelAssignments.tuned_model_id, vertexTunedModels.id))
      .where(and(...conditions))
      .orderBy(desc(vertexModelAssignments.activated_at))
      .limit(filters.limit ?? 100);

    return rows;
  }

  async activateAssignment(
    params: AssignmentScopeOwner & {
      slot: VertexTuningSlot;
      tunedModelId: string;
      assignedByUserId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<VertexModelAssignmentWithModel> {
    const owner = normalizeScopeOwner(params);

    return dbWrite.transaction(async (tx) => {
      // Only a tuned model the caller can actually SEE (global + own-org +
      // own-user) may be bound to their assignment slot. Resolving by id alone
      // let one org activate another org's private fine-tuned model into its
      // own inference slot. Mirrors buildModelVisibilityCondition on the list
      // path; a non-visible id is indistinguishable from a missing one.
      const tunedModel = await tx.query.vertexTunedModels.findFirst({
        where: and(
          eq(vertexTunedModels.id, params.tunedModelId),
          buildModelVisibilityCondition({
            organizationId: owner.organizationId,
            userId: owner.userId,
          }),
        ),
      });

      if (!tunedModel) {
        throw new Error("Tuned model not found");
      }

      const scopeCondition = buildActiveAssignmentCondition(owner, params.slot);

      await tx
        .update(vertexModelAssignments)
        .set({
          is_active: false,
          deactivated_at: new Date(),
          updated_at: new Date(),
        })
        .where(scopeCondition);

      const [assignment] = await tx
        .insert(vertexModelAssignments)
        .values({
          scope: owner.scope,
          slot: params.slot,
          organization_id: owner.organizationId,
          user_id: owner.userId,
          tuned_model_id: params.tunedModelId,
          assigned_by_user_id:
            params.assignedByUserId && isValidUUID(params.assignedByUserId)
              ? params.assignedByUserId
              : undefined,
          metadata: params.metadata ?? {},
          is_active: true,
          activated_at: new Date(),
          updated_at: new Date(),
        })
        .returning();

      return {
        assignment,
        tunedModel,
      };
    });
  }

  async deactivateAssignment(
    params: AssignmentScopeOwner & { slot: VertexTuningSlot },
  ): Promise<number> {
    const owner = normalizeScopeOwner(params);
    const now = new Date();

    const scopeCondition = buildActiveAssignmentCondition(owner, params.slot);

    const result = await dbWrite
      .update(vertexModelAssignments)
      .set({
        is_active: false,
        deactivated_at: now,
        updated_at: now,
      })
      .where(scopeCondition)
      .returning({ id: vertexModelAssignments.id });

    return result.length;
  }

  async resolveModelPreferences(viewer: ViewerScope): Promise<ResolvedModelPreferences> {
    const assignments = await this.listVisibleAssignments(viewer, {
      activeOnly: true,
      limit: 32,
    });

    const sortedAssignments = assignments.sort((a, b) => {
      const scopeDiff = getScopePriority(a.assignment.scope) - getScopePriority(b.assignment.scope);
      if (scopeDiff !== 0) {
        return scopeDiff;
      }
      return a.assignment.activated_at.getTime() - b.assignment.activated_at.getTime();
    });

    const sources: ResolvedModelPreferences["sources"] = {};
    let merged: ModelPreferences | undefined;

    for (const assignment of sortedAssignments) {
      const normalized = normalizeModelPreferences(assignment.tunedModel.model_preferences);
      if (!normalized) {
        continue;
      }

      merged = mergeModelPreferences(merged, normalized);
      for (const [key, value] of Object.entries(normalized) as Array<
        [ModelPreferenceKey, string]
      >) {
        if (value) {
          sources[key] = assignment;
        }
      }
    }

    return {
      modelPreferences: merged,
      assignments: sortedAssignments,
      sources,
    };
  }

  private async publishTunedModel(
    tx: DbTransaction,
    job: VertexTuningJobRecord,
    remote: TuningJob,
  ): Promise<VertexTunedModelRecord> {
    const id = getRecommendedModelId(remote, job.display_name);
    const preferences =
      buildVertexModelPreferencePatch({
        slot: job.slot,
        tunedModelId: id,
        scope: job.scope,
        ownerId: job.user_id ?? job.organization_id ?? undefined,
      }).modelPreferences ?? {};
    const [created] = await tx
      .insert(vertexTunedModels)
      .values({
        tuning_job_id: job.id,
        vertex_model_id: id,
        display_name: remote.tunedModelDisplayName ?? job.display_name,
        base_model: job.base_model,
        project_id: job.project_id,
        region: job.region,
        slot: job.slot,
        source_scope: job.scope,
        organization_id: job.organization_id,
        user_id: job.user_id,
        model_preferences: preferences as Record<string, string>,
        metadata: {
          vertexJobName: job.vertex_job_name,
          createTime: remote.createTime,
          updateTime: remote.updateTime,
          resources: vertexTunedResources(remote),
          completionTime: job.completed_provider_time,
        },
        updated_at: new Date(remote.updateTime),
      })
      .onConflictDoNothing({ target: vertexTunedModels.vertex_model_id })
      .returning();
    if (created) return created;
    const [existing] = await tx
      .select()
      .from(vertexTunedModels)
      .where(eq(vertexTunedModels.vertex_model_id, id))
      .for("update");
    if (
      !existing ||
      existing.tuning_job_id !== job.id ||
      existing.source_scope !== job.scope ||
      existing.organization_id !== job.organization_id ||
      existing.user_id !== job.user_id ||
      existing.project_id !== job.project_id ||
      existing.region !== job.region ||
      existing.slot !== job.slot
    )
      return vertexObservationError(
        "VERTEX_MODEL_IDENTITY_CONFLICT",
        "Tuned model is bound to another original job or owner",
      );
    return existing;
  }
}

export const vertexModelRegistryService = new VertexModelRegistryService();
