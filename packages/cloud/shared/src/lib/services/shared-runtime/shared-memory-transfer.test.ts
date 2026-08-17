/**
 * Deterministic contract tests for the cloud-side Shared→Dedicated memory
 * push: scope derivation matches the turn-path writer, keyset pagination walks
 * the full history without skips, batches carry the wire shape the container
 * route validates, counts aggregate honestly, and a rejected batch fails the
 * transfer with a typed error instead of reporting success. Reader and fetch
 * are recorder doubles; no network or DB.
 */

import { describe, expect, test } from "bun:test";
import { stringToUuid } from "@elizaos/core/edge";
import type { SharedAgentMemoryRow } from "../../../db/schemas/shared-agent-memories";
import {
  SHARED_MEMORY_TRANSFER_PAGE,
  type SharedMemoryTransferReader,
  sharedMemoryScopeForAgent,
  transferSharedMemoriesToDedicated,
} from "./shared-memory-transfer";

const AGENT = {
  id: "personal:327fd128-cb80-5f3a-aedd-47b3c465c805",
  organization_id: "75ae457b-801f-43e1-9d95-5585147655cd",
  user_id: "f210269b-8148-428b-8c24-91da4c95c727",
};
const TARGET = { baseUrl: "http://agent.tailnet.test:2138/", apiToken: "tok" };

function row(index: number, overrides: Partial<SharedAgentMemoryRow> = {}): SharedAgentMemoryRow {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    organization_id: AGENT.organization_id,
    user_id: AGENT.user_id,
    agent_id: sharedMemoryScopeForAgent(AGENT).agentId,
    entity_id: "3a0731c4-5a3c-4a3f-9d6e-0f6f10a4c111",
    room_id: "9610511b-dff2-5ca3-989a-8e1004ff44b1",
    world_id: "022a61e3-2968-4c5a-a510-ac7bac458464",
    type: "messages",
    content: { text: `m${index}` },
    embedding: Array.from({ length: 384 }, () => 0.5),
    embedding_model: "bge-small-en-v1.5",
    created_at: new Date(1755400000000 + index * 1000),
    ...overrides,
  } as SharedAgentMemoryRow;
}

function pagedReader(rows: SharedAgentMemoryRow[]): SharedMemoryTransferReader & {
  calls: Array<{ after?: { createdAt: Date; id: string } }>;
} {
  const calls: Array<{ after?: { createdAt: Date; id: string } }> = [];
  return {
    calls,
    async listOldestByScope(_scope, limit, after) {
      calls.push({ after });
      const start = after ? rows.findIndex((r) => r.id === after.id) + 1 : 0;
      return rows.slice(start, start + limit);
    },
  };
}

function recordingFetch(status = 200) {
  const bodies: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(url));
    headers.push({ ...((init?.headers ?? {}) as Record<string, string>) });
    const body = JSON.parse(String(init?.body)) as { exports: unknown[] };
    bodies.push(body);
    if (status !== 200) return new Response("nope", { status });
    return Response.json({
      ok: true,
      imported: body.exports.length,
      skippedExisting: 0,
      embeddingsWritten: body.exports.length,
    });
  }) as typeof fetch;
  return { impl, bodies, urls, headers };
}

describe("shared→dedicated memory transfer", () => {
  test("scope matches the turn-path writer derivation exactly", () => {
    const scope = sharedMemoryScopeForAgent(AGENT);
    expect(scope.organizationId).toBe(AGENT.organization_id);
    expect(scope.userId).toBe(AGENT.user_id);
    expect(scope.agentId).toBe(stringToUuid(`shared-todos:agent:${AGENT.id}`));
  });

  test("walks every page oldest-first and posts the wire shape the route validates", async () => {
    const rows = Array.from({ length: SHARED_MEMORY_TRANSFER_PAGE + 3 }, (_, i) => row(i));
    const reader = pagedReader(rows);
    const net = recordingFetch();

    const result = await transferSharedMemoriesToDedicated(AGENT, TARGET, {
      reader,
      fetchImpl: net.impl,
    });

    expect(result.rows).toBe(rows.length);
    expect(result.imported).toBe(rows.length);
    expect(result.embeddingsWritten).toBe(rows.length);
    expect(result.droppedEmbeddings).toBe(0);
    // 203 rows at page size 200: one full page, then the short terminal page.
    expect(reader.calls.length).toBe(2);
    expect(reader.calls[1]?.after?.id).toBe(rows[SHARED_MEMORY_TRANSFER_PAGE - 1]?.id);
    expect(net.urls[0]).toBe("http://agent.tailnet.test:2138/api/memories/import");
    expect(net.headers[0]?.Authorization).toBe("Bearer tok");

    const first = (net.bodies[0]?.exports as Array<Record<string, unknown>>)[0] as {
      memory: Record<string, unknown>;
      embedding?: { dim_384: number[] };
    };
    expect(first.memory.id).toBe(rows[0]?.id);
    expect(first.memory.created_at).toBe(rows[0]?.created_at.toISOString());
    expect(first.memory.content).toEqual(rows[0]?.content as Record<string, unknown>);
    expect(first.embedding?.dim_384).toHaveLength(384);
  });

  test("aggregates container counts and surfaces dropped anomalous vectors", async () => {
    const rows = [row(0), row(1, { embedding: Array.from({ length: 768 }, () => 0.1) })];
    const net = recordingFetch();

    const result = await transferSharedMemoriesToDedicated(AGENT, TARGET, {
      reader: pagedReader(rows),
      fetchImpl: net.impl,
    });

    expect(result.rows).toBe(2);
    expect(result.droppedEmbeddings).toBe(1);
    const batch = net.bodies[0]?.exports as Array<{ embedding?: unknown }>;
    expect(batch[0]?.embedding).toBeDefined();
    expect(batch[1]?.embedding).toBeUndefined();
  });

  test("a rejected batch throws typed and never reports success", async () => {
    const net = recordingFetch(503);
    await expect(
      transferSharedMemoriesToDedicated(AGENT, TARGET, {
        reader: pagedReader([row(0)]),
        fetchImpl: net.impl,
      }),
    ).rejects.toMatchObject({ code: "SHARED_MEMORY_TRANSFER_FAILED" });
  });

  test("an empty history transfers as a zero-count no-op without network calls", async () => {
    const net = recordingFetch();
    const result = await transferSharedMemoriesToDedicated(AGENT, TARGET, {
      reader: pagedReader([]),
      fetchImpl: net.impl,
    });
    expect(result).toEqual({
      rows: 0,
      batches: 0,
      imported: 0,
      skippedExisting: 0,
      embeddingsWritten: 0,
      droppedEmbeddings: 0,
    });
    expect(net.urls).toHaveLength(0);
  });
});
