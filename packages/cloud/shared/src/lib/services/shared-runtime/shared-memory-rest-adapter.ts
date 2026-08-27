/**
 * Product REST projection over the tenant-scoped Shared memory repository.
 * The Cloud catch-all owns HTTP/CORS; this service validates query input,
 * derives the same storage identity used by Shared turn writes, and returns the
 * existing Memories-view DTOs without leaking database row shape.
 */

import { validateUuid } from "@elizaos/core/edge";
import {
  type SharedAgentMemoriesReader,
  type SharedAgentMemoryScope,
  type SharedAgentMemoryTypeCount,
  sharedAgentMemoriesReader,
} from "../../../db/repositories/shared-agent-memories";
import type { SharedAgentMemoryRow } from "../../../db/schemas/shared-agent-memories";
import { sharedMemoryTablesEnabled } from "./shared-memory-store";
import { sharedTodoStorageScope } from "./shared-runtime-storage-identity";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_OFFSET = 100_000;
const MAX_QUERY_CHARACTERS = 512;
const MAX_TYPE_CHARACTERS = 128;
const MAX_ENTITY_FILTERS = 100;

export interface SharedMemoryRestIdentity {
  organizationId: string;
  userId: string;
  sourceAgentId: string;
}

export interface SharedMemoryRestRequest {
  path: string;
  searchParams: URLSearchParams;
  identity: SharedMemoryRestIdentity;
}

export interface SharedMemoryRestResult {
  status: 200 | 400 | 503;
  data: Record<string, unknown>;
}

interface SharedMemoryRestDependencies {
  enabled: boolean;
  reader: Pick<SharedAgentMemoriesReader, "listPage" | "countMatching" | "countByType">;
}

function invalidQuery(error: string): SharedMemoryRestResult {
  return {
    status: 400,
    data: {
      success: false,
      code: "invalid_memory_query",
      error,
    },
  };
}

function runtimeUnavailable(): SharedMemoryRestResult {
  return {
    status: 503,
    data: {
      success: false,
      code: "memory_runtime_unavailable",
      error: "Durable memories are not enabled for this Shared agent right now.",
      capability: "memories",
      retryable: false,
    },
  };
}

function parseBoundedInteger(
  params: URLSearchParams,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  const raw = params.get(key);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function parseOptionalText(
  params: URLSearchParams,
  key: string,
  maximum: number,
): string | null | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  return value.length <= maximum ? value : null;
}

function parseUuid(value: string): string | null {
  return validateUuid(value.trim());
}

function parseEntityIds(values: string[]): string[] | null {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (unique.length === 0 || unique.length > MAX_ENTITY_FILTERS) return null;
  const validated = unique.map(parseUuid);
  return validated.every((value): value is string => value !== null) ? validated : null;
}

function memoryScope(identity: SharedMemoryRestIdentity): SharedAgentMemoryScope {
  const storage = sharedTodoStorageScope({
    sourceAgentId: identity.sourceAgentId,
    ownerId: identity.userId,
  });
  return {
    organizationId: identity.organizationId,
    userId: identity.userId,
    agentId: storage.agentId,
  };
}

function browseItem(row: SharedAgentMemoryRow): Record<string, unknown> {
  const content = row.content;
  const metadata = content.metadata;
  return {
    id: row.id,
    type: row.type,
    text: typeof content.text === "string" ? content.text : "",
    entityId: row.entity_id,
    roomId: row.room_id,
    agentId: row.agent_id,
    createdAt: row.created_at.getTime(),
    metadata:
      metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : null,
    source: typeof content.source === "string" ? content.source : null,
  };
}

function typeCounts(rows: SharedAgentMemoryTypeCount[]): {
  total: number;
  byType: Record<string, number>;
} {
  const byType: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    byType[row.type] = row.count;
    total += row.count;
  }
  return { total, byType };
}

function entityPathId(path: string): string | null | undefined {
  const prefix = "memories/by-entity/";
  if (!path.startsWith(prefix)) return undefined;
  const encoded = path.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return null;
  try {
    return parseUuid(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

/** True only for the four Memories-view compatibility endpoint families. */
export function isSharedMemoryRestPath(path: string): boolean {
  return (
    path === "memories/feed" ||
    path === "memories/browse" ||
    path === "memories/stats" ||
    path.startsWith("memories/by-entity/")
  );
}

export async function sharedMemoryRestRequest(
  request: SharedMemoryRestRequest,
  dependencies: SharedMemoryRestDependencies = {
    enabled: sharedMemoryTablesEnabled(),
    reader: sharedAgentMemoriesReader,
  },
): Promise<SharedMemoryRestResult> {
  if (!dependencies.enabled) return runtimeUnavailable();

  const { path, searchParams } = request;
  const limit = parseBoundedInteger(searchParams, "limit", DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  if (limit === null) return invalidQuery("limit is outside supported bounds");
  const type = parseOptionalText(searchParams, "type", MAX_TYPE_CHARACTERS);
  if (type === null) return invalidQuery("type is too long");
  const scope = memoryScope(request.identity);

  if (path === "memories/stats") {
    return {
      status: 200,
      data: typeCounts(await dependencies.reader.countByType(scope)),
    };
  }

  if (path === "memories/feed") {
    const beforeRaw = searchParams.get("before");
    const before =
      beforeRaw === null
        ? undefined
        : /^\d+$/.test(beforeRaw) && Number.isSafeInteger(Number(beforeRaw))
          ? new Date(Number(beforeRaw))
          : null;
    if (before === null || (before && Number.isNaN(before.getTime()))) {
      return invalidQuery("before must be an epoch-millisecond timestamp");
    }
    const beforeIdRaw = searchParams.get("beforeId");
    const beforeId = beforeIdRaw ? parseUuid(beforeIdRaw) : undefined;
    if (beforeIdRaw && !beforeId) {
      return invalidQuery("beforeId must be a UUID");
    }
    if (beforeId && !before) {
      return invalidQuery("beforeId requires before");
    }
    const result = await dependencies.reader.listPage(scope, {
      limit,
      ...(type ? { type } : {}),
      ...(before ? { before } : {}),
      ...(beforeId ? { beforeId } : {}),
    });
    const memories = result.rows.map(browseItem);
    return {
      status: 200,
      data: {
        memories,
        count: memories.length,
        limit,
        hasMore: result.hasMore,
      },
    };
  }

  const offset = parseBoundedInteger(searchParams, "offset", 0, 0, MAX_OFFSET);
  if (offset === null) {
    return invalidQuery("offset is outside supported bounds");
  }
  const query = parseOptionalText(searchParams, "q", MAX_QUERY_CHARACTERS);
  if (query === null) return invalidQuery("q is too long");
  const roomRaw = searchParams.get("roomId");
  const roomId = roomRaw ? parseUuid(roomRaw) : undefined;
  if (roomRaw && !roomId) return invalidQuery("roomId must be a UUID");

  const pathEntityId = entityPathId(path);
  if (pathEntityId === null) return invalidQuery("entityId must be a UUID");
  const queryEntityIdRaw = searchParams.get("entityId");
  const queryEntityId = queryEntityIdRaw ? parseUuid(queryEntityIdRaw) : undefined;
  if (queryEntityIdRaw && !queryEntityId) {
    return invalidQuery("entityId must be a UUID");
  }
  const entityIdsRaw = searchParams.get("entityIds");
  const requestedEntityIds = entityIdsRaw ? parseEntityIds(entityIdsRaw.split(",")) : [];
  if (requestedEntityIds === null) {
    return invalidQuery("entityIds must be a bounded UUID list");
  }
  const allEntityIds = [
    ...(typeof pathEntityId === "string" ? [pathEntityId] : []),
    ...(queryEntityId ? [queryEntityId] : []),
    ...requestedEntityIds,
  ];
  const scopedEntityIds = allEntityIds.length > 0 ? parseEntityIds([...allEntityIds]) : undefined;
  if (allEntityIds.length > 0 && !scopedEntityIds) {
    return invalidQuery("entityIds must be a bounded UUID list");
  }

  const filters = {
    ...(type ? { type } : {}),
    ...(scopedEntityIds ? { entityIds: scopedEntityIds } : {}),
    ...(roomId ? { roomId } : {}),
    ...(query ? { textQuery: query } : {}),
  };
  const [result, total] = await Promise.all([
    dependencies.reader.listPage(scope, {
      ...filters,
      limit,
      offset,
    }),
    dependencies.reader.countMatching(scope, filters),
  ]);
  const memories = result.rows.map(browseItem);
  return {
    status: 200,
    data: {
      ...(typeof pathEntityId === "string" ? { entityId: pathEntityId } : {}),
      memories,
      total,
      totalIsExact: true,
      hasMore: result.hasMore,
      limit,
      offset,
    },
  };
}
