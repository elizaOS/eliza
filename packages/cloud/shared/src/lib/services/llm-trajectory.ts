/**
 * LLM trajectory logging service for Eliza Cloud.
 *
 * Records LLM calls that pass through Cloud for training data collection when
 * the deployment capture policy allows it (see `config/llm-trajectory-policy`).
 * Called from ai-billing's `recordUsageAnalytics()`.
 *
 * Prompt/response bodies are encrypted at rest with the organization's field
 * key, bound to `llm_trajectories|<row id>|<column>`. They live in a dedicated
 * private object store when one is configured, otherwise inline in Postgres.
 * Rows written before encryption hold plaintext bodies; reads return those
 * as-is (see `decodeTrajectoryBody`).
 */

import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  type LlmTrajectory,
  llmTrajectories,
  type NewLlmTrajectory,
} from "../../db/schemas/llm-trajectories";
import { logger } from "../utils/logger";
import { fieldEncryption } from "./field-encryption";
import {
  deleteTrajectoryPayload,
  getTrajectoryPayload,
  privateTrajectoryStoreConfigured,
  putTrajectoryPayload,
  type TrajectoryInlinePayload,
  type TrajectoryPayloadStorage,
} from "./trajectory-object-storage";

export const LLM_TRAJECTORIES_TABLE = "llm_trajectories";

const BODY_COLUMNS = ["system_prompt", "user_prompt", "response_text"] as const;
type BodyColumn = (typeof BODY_COLUMNS)[number];

export interface LogCallParams {
  organizationId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  model: string;
  provider: string;
  purpose?: string;
  requestId?: string;
  systemPrompt?: string;
  userPrompt?: string;
  responseText?: string;
  inputTokens?: number;
  outputTokens?: number;
  inputCost?: number;
  outputCost?: number;
  latencyMs?: number;
  isSuccessful?: boolean;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface TrajectoryFilters {
  model?: string;
  purpose?: string;
  startDate?: Date;
  endDate?: Date;
  isSuccessful?: boolean;
  limit?: number;
  offset?: number;
}

export interface TrajectoryExportOptions {
  model?: string;
  purpose?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
}

function bodyCoords(rowId: string, column: BodyColumn) {
  return { table: LLM_TRAJECTORIES_TABLE, rowId, column };
}

async function encryptBodies(
  organizationId: string,
  rowId: string,
  body: TrajectoryInlinePayload,
): Promise<TrajectoryInlinePayload> {
  const out: TrajectoryInlinePayload = {
    system_prompt: null,
    user_prompt: null,
    response_text: null,
  };
  for (const column of BODY_COLUMNS) {
    const value = body[column];
    out[column] =
      value === null
        ? null
        : await fieldEncryption.encrypt(organizationId, value, bodyCoords(rowId, column));
  }
  return out;
}

/**
 * Decode one stored body. Encrypted values are decrypted against their row
 * coordinates (a relocated ciphertext fails). Rows captured before at-rest
 * encryption hold plaintext; those are returned unchanged and age out through
 * the retention purge.
 */
export async function decodeTrajectoryBody(
  value: string | null,
  rowId: string,
  column: BodyColumn,
): Promise<string | null> {
  if (value === null) return null;
  if (!fieldEncryption.isEncrypted(value)) return value;
  return fieldEncryption.decrypt(value, bodyCoords(rowId, column));
}

async function decodeBodies(
  rowId: string,
  body: TrajectoryInlinePayload,
): Promise<TrajectoryInlinePayload> {
  return {
    system_prompt: await decodeTrajectoryBody(body.system_prompt, rowId, "system_prompt"),
    user_prompt: await decodeTrajectoryBody(body.user_prompt, rowId, "user_prompt"),
    response_text: await decodeTrajectoryBody(body.response_text, rowId, "response_text"),
  };
}

function isObjectStorage(storage: string): storage is Exclude<TrajectoryPayloadStorage, "inline"> {
  return storage === "private_object" || storage === "r2";
}

async function hydrateTrajectory(row: LlmTrajectory): Promise<LlmTrajectory> {
  const storage = row.trajectory_payload_storage;
  if (storage === "inline") {
    return { ...row, ...(await decodeBodies(row.id, row)) };
  }
  if (!isObjectStorage(storage) || !row.trajectory_payload_key) {
    throw new ElizaError("Trajectory payload reference is invalid", {
      code: "TRAJECTORY_PAYLOAD_INVALID",
      context: { trajectoryId: row.id, storage },
    });
  }
  const payload = await getTrajectoryPayload(storage, row.trajectory_payload_key);
  if (!payload) {
    throw new ElizaError("Trajectory payload object is missing", {
      code: "TRAJECTORY_PAYLOAD_MISSING",
      context: { trajectoryId: row.id, storage },
    });
  }
  return { ...row, ...(await decodeBodies(row.id, payload)) };
}

class LlmTrajectoryService {
  /**
   * Record one LLM call. Callers check the deployment capture policy first.
   * Bodies are encrypted before they leave this process; a failed write
   * throws (after removing any payload object it already stored).
   */
  async logCall(params: LogCallParams): Promise<void> {
    const totalTokens = (params.inputTokens ?? 0) + (params.outputTokens ?? 0);
    const totalCost = (params.inputCost ?? 0) + (params.outputCost ?? 0);
    const id = randomUUID();
    const createdAt = new Date();

    const plainBodies: TrajectoryInlinePayload = {
      system_prompt: params.systemPrompt ?? null,
      user_prompt: params.userPrompt ?? null,
      response_text: params.responseText ?? null,
    };
    const hasBodies = BODY_COLUMNS.some((column) => (plainBodies[column] ?? "") !== "");
    const encrypted = hasBodies
      ? await encryptBodies(params.organizationId, id, plainBodies)
      : plainBodies;

    let trajectory_payload_storage: TrajectoryPayloadStorage = "inline";
    let trajectory_payload_key: string | null = null;
    let inlineBodies = encrypted;

    if (hasBodies && privateTrajectoryStoreConfigured()) {
      trajectory_payload_storage = "private_object";
      trajectory_payload_key = await putTrajectoryPayload({
        organizationId: params.organizationId,
        trajectoryId: id,
        createdAt,
        body: encrypted,
      });
      inlineBodies = { system_prompt: null, user_prompt: null, response_text: null };
    }

    const record: NewLlmTrajectory = {
      id,
      organization_id: params.organizationId,
      user_id: params.userId ?? undefined,
      api_key_id: params.apiKeyId ?? undefined,
      model: params.model,
      provider: params.provider,
      purpose: params.purpose ?? null,
      request_id: params.requestId ?? null,
      ...inlineBodies,
      trajectory_payload_storage,
      trajectory_payload_key,
      input_tokens: params.inputTokens ?? 0,
      output_tokens: params.outputTokens ?? 0,
      total_tokens: totalTokens,
      input_cost: params.inputCost?.toFixed(6) ?? "0.000000",
      output_cost: params.outputCost?.toFixed(6) ?? "0.000000",
      total_cost: totalCost.toFixed(6),
      latency_ms: params.latencyMs ?? null,
      is_successful: params.isSuccessful ?? true,
      error_message: params.errorMessage ?? null,
      metadata: params.metadata ?? {},
      created_at: createdAt,
    };

    try {
      await db.insert(llmTrajectories).values(record);
    } catch (error) {
      if (trajectory_payload_key) {
        await deleteTrajectoryPayload("private_object", trajectory_payload_key).catch(
          (cleanupError: unknown) => {
            logger.error("[llm-trajectory] Failed to remove orphaned payload", {
              key: trajectory_payload_key,
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            });
          },
        );
      }
      throw error;
    }
  }

  /**
   * List trajectories for an organization.
   */
  async listByOrganization(organizationId: string, filters: TrajectoryFilters = {}) {
    const conditions = [eq(llmTrajectories.organization_id, organizationId)];

    if (filters.model) {
      conditions.push(eq(llmTrajectories.model, filters.model));
    }
    if (filters.purpose) {
      conditions.push(eq(llmTrajectories.purpose, filters.purpose));
    }
    if (filters.startDate) {
      conditions.push(gte(llmTrajectories.created_at, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(llmTrajectories.created_at, filters.endDate));
    }
    if (filters.isSuccessful !== undefined) {
      conditions.push(eq(llmTrajectories.is_successful, filters.isSuccessful));
    }

    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    const rows = await db
      .select()
      .from(llmTrajectories)
      .where(and(...conditions))
      .orderBy(desc(llmTrajectories.created_at))
      .limit(limit)
      .offset(offset);

    const trajectories = await Promise.all(rows.map((row) => hydrateTrajectory(row)));

    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(llmTrajectories)
      .where(and(...conditions));

    return {
      trajectories,
      total: Number(countResult?.count ?? 0),
      limit,
      offset,
    };
  }

  /**
   * Get aggregate stats for an organization's trajectories.
   */
  async getStats(organizationId: string) {
    const [result] = await db
      .select({
        total: sql<number>`count(*)`,
        totalInputTokens: sql<number>`coalesce(sum(input_tokens), 0)`,
        totalOutputTokens: sql<number>`coalesce(sum(output_tokens), 0)`,
        avgLatencyMs: sql<number>`coalesce(avg(latency_ms), 0)`,
        successCount: sql<number>`count(*) filter (where is_successful = true)`,
        failureCount: sql<number>`count(*) filter (where is_successful = false)`,
      })
      .from(llmTrajectories)
      .where(eq(llmTrajectories.organization_id, organizationId));

    const byPurpose = await db
      .select({
        purpose: llmTrajectories.purpose,
        count: sql<number>`count(*)`,
      })
      .from(llmTrajectories)
      .where(eq(llmTrajectories.organization_id, organizationId))
      .groupBy(llmTrajectories.purpose);

    const byModel = await db
      .select({
        model: llmTrajectories.model,
        count: sql<number>`count(*)`,
      })
      .from(llmTrajectories)
      .where(eq(llmTrajectories.organization_id, organizationId))
      .groupBy(llmTrajectories.model);

    return {
      total: Number(result?.total ?? 0),
      totalInputTokens: Number(result?.totalInputTokens ?? 0),
      totalOutputTokens: Number(result?.totalOutputTokens ?? 0),
      avgLatencyMs: Math.round(Number(result?.avgLatencyMs ?? 0)),
      successCount: Number(result?.successCount ?? 0),
      failureCount: Number(result?.failureCount ?? 0),
      byPurpose: byPurpose.map((r: { purpose: string | null; count: unknown }) => ({
        purpose: r.purpose,
        count: Number(r.count),
      })),
      byModel: byModel.map((r: { model: string; count: unknown }) => ({
        model: r.model,
        count: Number(r.count),
      })),
    };
  }

  /**
   * Export trajectories as JSONL for Gemini supervised tuning.
   */
  async exportAsTrainingJSONL(
    organizationId: string,
    options: TrajectoryExportOptions = {},
  ): Promise<string> {
    const conditions = [eq(llmTrajectories.organization_id, organizationId)];
    conditions.push(eq(llmTrajectories.is_successful, true));

    if (options.model) {
      conditions.push(eq(llmTrajectories.model, options.model));
    }
    if (options.purpose) {
      conditions.push(eq(llmTrajectories.purpose, options.purpose));
    }
    if (options.startDate) {
      conditions.push(gte(llmTrajectories.created_at, options.startDate));
    }
    if (options.endDate) {
      conditions.push(lte(llmTrajectories.created_at, options.endDate));
    }

    const rows = await db
      .select()
      .from(llmTrajectories)
      .where(and(...conditions))
      .orderBy(desc(llmTrajectories.created_at))
      .limit(options.limit ?? 10000);

    const hydrated = await Promise.all(rows.map((row) => hydrateTrajectory(row)));

    const lines: string[] = [];
    for (const row of hydrated) {
      if (!row.user_prompt || !row.response_text) continue;

      const messages: Array<{ role: string; content: string }> = [];

      if (row.system_prompt) {
        messages.push({ role: "system", content: row.system_prompt });
      }

      messages.push({ role: "user", content: row.user_prompt });
      messages.push({ role: "model", content: row.response_text });

      lines.push(JSON.stringify({ messages }));
    }

    return lines.join("\n");
  }
}

export const llmTrajectoryService = new LlmTrajectoryService();
