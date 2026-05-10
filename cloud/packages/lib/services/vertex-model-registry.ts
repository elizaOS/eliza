import { and, desc, eq, or } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import {
  type VertexModelAssignmentRecord,
  type VertexTunedModelRecord,
  type VertexTuningJobRecord,
  vertexModelAssignments,
  vertexTunedModels,
  vertexTuningJobs,
} from "@/db/schemas";
import type { ModelPreferenceKey, ModelPreferences } from "@/lib/eliza/model-preferences";
import { mergeModelPreferences, normalizeModelPreferences } from "@/lib/eliza/model-preferences";
import { ObjectNamespaces } from "@/lib/storage/object-namespace";
import { hydrateJsonField, offloadJsonField } from "@/lib/storage/object-store";
import { logger } from "@/lib/utils/logger";
import { isValidUUID } from "@/lib/utils/validation";
import {
  buildVertexModelPreferencePatch,
  getTuningJobStatus,
  type TuningJob,
  type VertexTuningScope,
  type VertexTuningSlot,
} from "./vertex-tuning";

type ViewerScope = {
  organizationId?: string;
  userId?: string;
};

type AssignmentScopeOwner = {
  scope: VertexTuningScope;
  organizationId?: string;
  userId?: string;
};

type NormalizedScopeOwner = {
  scope: VertexTuningScope;
  organizationId?: string;
  userId?: string;
};

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

function isTerminalJobState(state: TuningJob["state"]): boolean {
  return (
    state === "JOB_STATE_SUCCEEDED" ||
    state === "JOB_STATE_FAILED" ||
    state === "JOB_STATE_CANCELLED"
  );
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

function buildVisibilityCondition(viewer: ViewerScope) {
  const clauses = [eq(vertexTuningJobs.scope, "global")];

  if (viewer.organizationId && isValidUUID(viewer.organizationId)) {
    clauses.push(
      and(
        eq(vertexTuningJobs.scope, "organization"),
        eq(vertexTuningJobs.organization_id, viewer.organizationId),
      )!,
    );
  }

  if (viewer.userId && isValidUUID(viewer.userId)) {
    clauses.push(
      and(eq(vertexTuningJobs.scope, "user"), eq(vertexTuningJobs.user_id, viewer.userId))!,
    );
  }

  return clauses.length === 1 ? clauses[0] : or(...clauses)!;
}

function buildModelVisibilityCondition(viewer: ViewerScope) {
  const clauses = [eq(vertexTunedModels.source_scope, "global")];

  if (viewer.organizationId && isValidUUID(viewer.organizationId)) {
    clauses.push(
      and(
        eq(vertexTunedModels.source_scope, "organization"),
        eq(vertexTunedModels.organization_id, viewer.organizationId),
      )!,
    );
  }

  if (viewer.userId && isValidUUID(viewer.userId)) {
    clauses.push(
      and(
        eq(vertexTunedModels.source_scope, "user"),
        eq(vertexTunedModels.user_id, viewer.userId),
      )!,
    );
  }

  return clauses.length === 1 ? clauses[0] : or(...clauses)!;
}

function buildAssignmentVisibilityCondition(viewer: ViewerScope) {
  const clauses = [eq(vertexModelAssignments.scope, "global")];

  if (viewer.organizationId && isValidUUID(viewer.organizationId)) {
    clauses.push(
      and(
        eq(vertexModelAssignments.scope, "organization"),
        eq(vertexModelAssignments.organization_id, viewer.organizationId),
      )!,
    );
  }

  if (viewer.userId && isValidUUID(viewer.userId)) {
    clauses.push(
      and(
        eq(vertexModelAssignments.scope, "user"),
        eq(vertexModelAssignments.user_id, viewer.userId),
      )!,
    );
  }

  return clauses.length === 1 ? clauses[0] : or(...clauses)!;
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
  return (
    remoteJob.tunedModelEndpointName?.trim() ||
    remoteJob.tunedModelDisplayName?.trim() ||
    fallbackDisplayName
  );
}

async function hydrateVertexTuningJob(job: VertexTuningJobRecord): Promise<VertexTuningJobRecord> {
  const lastRemotePayload = await hydrateJsonField<Record<string, unknown>>({
    storage: job.last_remote_payload_storage,
    key: job.last_remote_payload_key,
    inlineValue: job.last_remote_payload,
  });

  return { ...job, last_remote_payload: lastRemotePayload ?? {} };
}

async function prepareRemotePayloadFields(params: {
  organizationId?: string;
  objectId: string;
  createdAt: Date;
  remoteJob: TuningJob;
}): Promise<
  Pick<
    VertexTuningJobRecord,
    "last_remote_payload" | "last_remote_payload_storage" | "last_remote_payload_key"
  >
> {
  const payload = await offloadJsonField<Record<string, unknown>>({
    namespace: ObjectNamespaces.VertexTuningPayloads,
    organizationId: params.organizationId ?? "global",
    objectId: params.objectId,
    field: "last_remote_payload",
    createdAt: params.createdAt,
    value: { ...params.remoteJob },
    inlineValueWhenOffloaded: {},
  });

  return {
    last_remote_payload: payload.value ?? {},
    last_remote_payload_storage: payload.storage,
    last_remote_payload_key: payload.key,
  };
}

export class VertexModelRegistryService {
  async recordSubmittedJob(
    input: RecordSubmittedVertexTuningJobInput,
  ): Promise<VertexTuningJobRecordWithModel> {
    const owner = normalizeScopeOwner(input);
    const recommendedModelId = input.recommendedModelId?.trim()
      ? input.recommendedModelId.trim()
      : getRecommendedModelId(input.remoteJob, input.displayName);
    const patch = buildVertexModelPreferencePatch({
      slot: input.slot,
      tunedModelId: recommendedModelId,
      scope: owner.scope,
      ownerId: owner.userId ?? owner.organizationId,
    });
    const completedAt = isTerminalJobState(input.remoteJob.state) ? new Date() : null;
    const remotePayloadFields = await prepareRemotePayloadFields({
      organizationId: owner.organizationId,
      objectId: input.vertexJobName,
      createdAt: new Date(input.remoteJob.updateTime),
      remoteJob: input.remoteJob,
    });

    const [job] = await dbWrite
      .insert(vertexTuningJobs)
      .values({
        vertex_job_name: input.vertexJobName,
        project_id: input.projectId,
        region: input.region,
        display_name: input.displayName,
        base_model: input.baseModel,
        slot: input.slot,
        scope: owner.scope,
        organization_id: owner.organizationId,
        user_id: owner.userId,
        created_by_user_id:
          input.createdByUserId && isValidUUID(input.createdByUserId)
            ? input.createdByUserId
            : undefined,
        training_data_path: input.trainingDataPath,
        validation_data_path: input.validationDataPath,
        training_data_uri: input.trainingDataUri,
        validation_data_uri: input.validationDataUri,
        recommended_model_id: recommendedModelId,
        tuned_model_display_name: input.remoteJob.tunedModelDisplayName,
        tuned_model_endpoint_name: input.remoteJob.tunedModelEndpointName,
        status: input.remoteJob.state,
        error_code: input.remoteJob.error?.code,
        error_message: input.remoteJob.error?.message,
        model_preference_patch: patch.modelPreferences as Record<string, string>,
        ...remotePayloadFields,
        metadata: input.metadata ?? {},
        completed_at: completedAt,
        created_at: new Date(input.remoteJob.createTime),
        updated_at: new Date(input.remoteJob.updateTime),
      })
      .onConflictDoUpdate({
        target: vertexTuningJobs.vertex_job_name,
        set: {
          project_id: input.projectId,
          region: input.region,
          display_name: input.displayName,
          base_model: input.baseModel,
          slot: input.slot,
          scope: owner.scope,
          organization_id: owner.organizationId,
          user_id: owner.userId,
          created_by_user_id:
            input.createdByUserId && isValidUUID(input.createdByUserId)
              ? input.createdByUserId
              : undefined,
          training_data_path: input.trainingDataPath,
          validation_data_path: input.validationDataPath,
          training_data_uri: input.trainingDataUri,
          validation_data_uri: input.validationDataUri,
          recommended_model_id: recommendedModelId,
          tuned_model_display_name: input.remoteJob.tunedModelDisplayName,
          tuned_model_endpoint_name: input.remoteJob.tunedModelEndpointName,
          status: input.remoteJob.state,
          error_code: input.remoteJob.error?.code,
          error_message: input.remoteJob.error?.message,
          model_preference_patch: patch.modelPreferences as Record<string, string>,
          ...remotePayloadFields,
          metadata: input.metadata ?? {},
          completed_at: completedAt,
          updated_at: new Date(input.remoteJob.updateTime),
        },
      })
      .returning();

    const tunedModel =
      input.remoteJob.state === "JOB_STATE_SUCCEEDED"
        ? await this.upsertTunedModelFromJob(job, input.remoteJob)
        : undefined;

    return { job: await hydrateVertexTuningJob(job), tunedModel };
  }

  async syncJobStatus(params: {
    jobId?: string;
    vertexJobName?: string;
  }): Promise<VertexTuningJobRecordWithModel | null> {
    const job = params.jobId
      ? await dbRead.query.vertexTuningJobs.findFirst({
          where: eq(vertexTuningJobs.id, params.jobId),
        })
      : params.vertexJobName
        ? await dbRead.query.vertexTuningJobs.findFirst({
            where: eq(vertexTuningJobs.vertex_job_name, params.vertexJobName),
          })
        : null;

    if (!job) {
      return null;
    }

    const remoteJob = await getTuningJobStatus(job.vertex_job_name);
    const recommendedModelId = getRecommendedModelId(remoteJob, job.display_name);
    const remotePayloadFields = await prepareRemotePayloadFields({
      organizationId: job.organization_id ?? undefined,
      objectId: job.vertex_job_name,
      createdAt: new Date(remoteJob.updateTime),
      remoteJob,
    });
    const [updatedJob] = await dbWrite
      .update(vertexTuningJobs)
      .set({
        recommended_model_id: recommendedModelId,
        tuned_model_display_name: remoteJob.tunedModelDisplayName,
        tuned_model_endpoint_name: remoteJob.tunedModelEndpointName,
        status: remoteJob.state,
        error_code: remoteJob.error?.code,
        error_message: remoteJob.error?.message,
        ...remotePayloadFields,
        completed_at: isTerminalJobState(remoteJob.state) ? new Date() : null,
        updated_at: new Date(remoteJob.updateTime),
      })
      .where(eq(vertexTuningJobs.id, job.id))
      .returning();

    const tunedModel =
      remoteJob.state === "JOB_STATE_SUCCEEDED"
        ? await this.upsertTunedModelFromJob(updatedJob, remoteJob)
        : undefined;

    return { job: await hydrateVertexTuningJob(updatedJob), tunedModel };
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

    return dbRead.query.vertexTuningJobs.findMany({
      where: and(...conditions),
      orderBy: [desc(vertexTuningJobs.created_at)],
      limit: filters.limit ?? 100,
    });
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
      const tunedModel = await tx.query.vertexTunedModels.findFirst({
        where: eq(vertexTunedModels.id, params.tunedModelId),
      });

      if (!tunedModel) {
        throw new Error("Tuned model not found");
      }

      let scopeCondition;
      switch (owner.scope) {
        case "global":
          scopeCondition = and(
            eq(vertexModelAssignments.scope, "global"),
            eq(vertexModelAssignments.slot, params.slot),
            eq(vertexModelAssignments.is_active, true),
          );
          break;
        case "organization":
          scopeCondition = and(
            eq(vertexModelAssignments.scope, "organization"),
            eq(vertexModelAssignments.organization_id, owner.organizationId!),
            eq(vertexModelAssignments.slot, params.slot),
            eq(vertexModelAssignments.is_active, true),
          );
          break;
        case "user":
          scopeCondition = and(
            eq(vertexModelAssignments.scope, "user"),
            eq(vertexModelAssignments.organization_id, owner.organizationId!),
            eq(vertexModelAssignments.user_id, owner.userId!),
            eq(vertexModelAssignments.slot, params.slot),
            eq(vertexModelAssignments.is_active, true),
          );
          break;
      }

      await tx
        .update(vertexModelAssignments)
        .set({
          is_active: false,
          deactivated_at: new Date(),
          updated_at: new Date(),
        })
        .where(scopeCondition!);

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

    let scopeCondition;
    switch (owner.scope) {
      case "global":
        scopeCondition = and(
          eq(vertexModelAssignments.scope, "global"),
          eq(vertexModelAssignments.slot, params.slot),
          eq(vertexModelAssignments.is_active, true),
        );
        break;
      case "organization":
        scopeCondition = and(
          eq(vertexModelAssignments.scope, "organization"),
          eq(vertexModelAssignments.organization_id, owner.organizationId!),
          eq(vertexModelAssignments.slot, params.slot),
          eq(vertexModelAssignments.is_active, true),
        );
        break;
      case "user":
        scopeCondition = and(
          eq(vertexModelAssignments.scope, "user"),
          eq(vertexModelAssignments.organization_id, owner.organizationId!),
          eq(vertexModelAssignments.user_id, owner.userId!),
          eq(vertexModelAssignments.slot, params.slot),
          eq(vertexModelAssignments.is_active, true),
        );
        break;
    }

    const result = await dbWrite
      .update(vertexModelAssignments)
      .set({
        is_active: false,
        deactivated_at: now,
        updated_at: now,
      })
      .where(scopeCondition!)
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

  private async upsertTunedModelFromJob(
    job: VertexTuningJobRecord,
    remoteJob: TuningJob,
  ): Promise<VertexTunedModelRecord> {
    const recommendedModelId = getRecommendedModelId(remoteJob, job.display_name);
    const modelPreferences =
      buildVertexModelPreferencePatch({
        slot: job.slot,
        tunedModelId: recommendedModelId,
        scope: job.scope,
        ownerId: job.user_id ?? job.organization_id ?? undefined,
      }).modelPreferences ?? {};

    const [model] = await dbWrite
      .insert(vertexTunedModels)
      .values({
        tuning_job_id: job.id,
        vertex_model_id: recommendedModelId,
        display_name: remoteJob.tunedModelDisplayName || job.display_name,
        base_model: job.base_model,
        project_id: job.project_id,
        region: job.region,
        slot: job.slot,
        source_scope: job.scope,
        organization_id: job.organization_id,
        user_id: job.user_id,
        model_preferences: modelPreferences as Record<string, string>,
        metadata: {
          vertexJobName: job.vertex_job_name,
          createTime: remoteJob.createTime,
          updateTime: remoteJob.updateTime,
        },
        updated_at: new Date(remoteJob.updateTime),
      })
      .onConflictDoUpdate({
        target: vertexTunedModels.vertex_model_id,
        set: {
          tuning_job_id: job.id,
          display_name: remoteJob.tunedModelDisplayName || job.display_name,
          base_model: job.base_model,
          project_id: job.project_id,
          region: job.region,
          slot: job.slot,
          source_scope: job.scope,
          organization_id: job.organization_id,
          user_id: job.user_id,
          model_preferences: modelPreferences as Record<string, string>,
          metadata: {
            vertexJobName: job.vertex_job_name,
            createTime: remoteJob.createTime,
            updateTime: remoteJob.updateTime,
          },
          updated_at: new Date(remoteJob.updateTime),
        },
      })
      .returning();

    logger.info("[VertexModelRegistry] Registered tuned model", {
      jobId: job.id,
      vertexJobName: job.vertex_job_name,
      tunedModelId: model.vertex_model_id,
      scope: job.scope,
      slot: job.slot,
    });

    return model;
  }
}

export const vertexModelRegistryService = new VertexModelRegistryService();
