/**
 * Cloud-side push of a tenant's Shared memory history into a Dedicated
 * container — the delivery leg of the Shared→Dedicated cutover. Reads the
 * agent's `shared_agent_memories` under the exact scope the Shared turn path
 * writes (organization/user plus the derived storage agent id), converts rows
 * through the lossless fidelity transform, and POSTs bounded batches to the
 * container's `/api/memories/import` route with its own API token.
 *
 * Ordering and resumability: pages walk oldest-first by (created_at, id)
 * keyset, and the container route is idempotent per memory id, so a retried or
 * resumed transfer converges without duplicating or skipping rows. Any batch
 * the container rejects fails the transfer with a typed error — a partial
 * import is safe to re-run, never silently reported as complete.
 */

import { ElizaError } from "@elizaos/core";
import type { SharedAgentMemoryScope } from "../../../db/repositories/shared-agent-memories";
import { sharedAgentMemoriesReader } from "../../../db/repositories/shared-agent-memories";
import type { SharedAgentMemoryRow } from "../../../db/schemas/shared-agent-memories";
import {
  type DedicatedMemoryExport,
  toDedicatedMemoryExports,
} from "./shared-memory-dedicated-export";
import { sharedTodoStorageScope } from "./shared-runtime-storage-identity";

export const SHARED_MEMORY_TRANSFER_BATCH = 500;
export const SHARED_MEMORY_TRANSFER_PAGE = 200;
export const SHARED_MEMORY_TRANSFER_FAILED = "SHARED_MEMORY_TRANSFER_FAILED";

/** The identity triple of the agent whose Shared history is being moved. */
export interface SharedMemoryTransferAgent {
  id: string;
  organization_id: string;
  user_id: string;
}

/** Container ingress: tailnet-reachable base URL plus its ELIZA_API_TOKEN. */
export interface SharedMemoryTransferTarget {
  baseUrl: string;
  apiToken: string;
}

export interface SharedMemoryTransferResult {
  rows: number;
  batches: number;
  imported: number;
  skippedExisting: number;
  embeddingsWritten: number;
  droppedEmbeddings: number;
}

interface ImportRouteResponse {
  ok: boolean;
  imported: number;
  skippedExisting: number;
  embeddingsWritten: number;
}

export interface SharedMemoryTransferReader {
  listOldestByScope(
    scope: SharedAgentMemoryScope,
    limit: number,
    after?: { createdAt: Date; id: string },
  ): Promise<SharedAgentMemoryRow[]>;
}

/**
 * The DB scope the Shared turn path writes this agent's memories under.
 * Mirrors `sharedTurnMemoryStore` in shared-runtime-chat: the row's agent_id
 * is the todo-storage derivation of the serving agent id, not the raw id.
 */
export function sharedMemoryScopeForAgent(
  agent: SharedMemoryTransferAgent,
): SharedAgentMemoryScope {
  return {
    organizationId: agent.organization_id,
    userId: agent.user_id,
    agentId: sharedTodoStorageScope({
      sourceAgentId: agent.id,
      ownerId: agent.user_id,
    }).agentId,
  };
}

function wireExport(item: DedicatedMemoryExport): Record<string, unknown> {
  return {
    memory: {
      ...item.memory,
      created_at: item.memory.created_at.toISOString(),
    },
    ...(item.embedding ? { embedding: item.embedding } : {}),
  };
}

async function postBatch(
  target: SharedMemoryTransferTarget,
  batch: DedicatedMemoryExport[],
  fetchImpl: typeof fetch,
): Promise<ImportRouteResponse> {
  const response = await fetchImpl(`${target.baseUrl.replace(/\/+$/, "")}/api/memories/import`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ exports: batch.map(wireExport) }),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new ElizaError("Dedicated container rejected a memory import batch", {
      code: SHARED_MEMORY_TRANSFER_FAILED,
      context: { status: response.status, detail, batchSize: batch.length },
    });
  }
  return (await response.json()) as ImportRouteResponse;
}

/**
 * Push the agent's complete Shared history into its Dedicated container.
 * Safe to re-run: already-present rows are counted as `skippedExisting`.
 */
export async function transferSharedMemoriesToDedicated(
  agent: SharedMemoryTransferAgent,
  target: SharedMemoryTransferTarget,
  options: {
    reader?: SharedMemoryTransferReader;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<SharedMemoryTransferResult> {
  const reader = options.reader ?? sharedAgentMemoriesReader;
  const fetchImpl = options.fetchImpl ?? fetch;
  const scope = sharedMemoryScopeForAgent(agent);

  const result: SharedMemoryTransferResult = {
    rows: 0,
    batches: 0,
    imported: 0,
    skippedExisting: 0,
    embeddingsWritten: 0,
    droppedEmbeddings: 0,
  };

  let after: { createdAt: Date; id: string } | undefined;
  let pending: DedicatedMemoryExport[] = [];

  const flush = async () => {
    if (pending.length === 0) return;
    const response = await postBatch(target, pending, fetchImpl);
    result.batches += 1;
    result.imported += response.imported;
    result.skippedExisting += response.skippedExisting;
    result.embeddingsWritten += response.embeddingsWritten;
    pending = [];
  };

  for (;;) {
    const page = await reader.listOldestByScope(scope, SHARED_MEMORY_TRANSFER_PAGE, after);
    if (page.length === 0) break;
    const last = page[page.length - 1] as SharedAgentMemoryRow;
    after = { createdAt: last.created_at, id: last.id };

    for (const item of toDedicatedMemoryExports(page)) {
      result.rows += 1;
      if (item.droppedEmbeddingDimension !== undefined) {
        result.droppedEmbeddings += 1;
      }
      pending.push(item);
      if (pending.length >= SHARED_MEMORY_TRANSFER_BATCH) await flush();
    }
    if (page.length < SHARED_MEMORY_TRANSFER_PAGE) break;
  }
  await flush();

  return result;
}
