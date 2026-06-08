/**
 * Unit tests for POST /api/v1/eliza/agents/[agentId]/write
 *
 * Covers:
 *  - Auth: missing service key, invalid key, valid key
 *  - Validation: invalid table, missing writeId, empty/oversize batch, bad JSON
 *  - Agent ownership: agent exists (200), agent not found (404)
 *  - SQL generation: insert, upsert, delete for all valid tables
 *  - Error handling: individual write failures, conflict detection, generic catch
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// ── Mocks (must be registered BEFORE the dynamic import) ──────────────────

const mockDbExecute = mock(async () => {});
const mockWithWriteDb = mock(
  async (cb: (db: { execute: typeof mockDbExecute }) => Promise<void>) =>
    cb({ execute: mockDbExecute }),
);

let requireServiceKeyImpl: (() => { organizationId: string }) | null = null;
let requireServiceKeyThrows: Error | null = null;

const mockRequireServiceKey = mock(async (_c: unknown) => {
  if (requireServiceKeyThrows) throw requireServiceKeyThrows;
  return requireServiceKeyImpl?.() ?? { organizationId: "org-1" };
});

const mockGetAgent = mock(async (_agentId: string, _orgId: string) => ({
  id: _agentId,
  name: "test-agent",
  bridge_url: null,
  status: "running",
}));

const mockLoggerInfo = mock(() => {});
const mockLoggerWarn = mock(() => {});
const mockLoggerError = mock(() => {});
const mockLoggerDebug = mock(() => {});

const mockFailureResponse = mock((_c: unknown, _error: unknown) =>
  Response.json({ success: false, error: "internal" }, { status: 500 }),
);

mock.module("@/db/client", () => ({
  withWriteDb: mockWithWriteDb,
}));

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  requireServiceKey: mockRequireServiceKey,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { getAgent: mockGetAgent },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: mockLoggerDebug,
  },
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: mockFailureResponse,
}));

// ── Import the route AFTER mocks are in place ─────────────────────────────

const { default: writeApp } = await import(
  "../v1/eliza/agents/[agentId]/write/route"
);

// ── Test helpers ──────────────────────────────────────────────────────────

function makeApp(): Hono {
  const parent = new Hono();
  parent.route("/v1/eliza/agents/:agentId/write", writeApp);
  return parent;
}

function writeRequest(
  agentId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost/v1/eliza/agents/${agentId}/write`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function validWrite(
  overrides: Partial<{
    table: string;
    operation: string;
    row: Record<string, unknown>;
    writeId: string;
  }> = {},
) {
  return {
    writes: [
      {
        table: overrides.table ?? "memories",
        operation: overrides.operation ?? "insert",
        row: overrides.row ?? {
          id: "00000000-0000-0000-0000-000000000001",
          type: "test",
          agent_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          content: { text: "hello" },
          created_at: new Date().toISOString(),
        },
        writeId: overrides.writeId ?? "write-1",
      },
    ],
  };
}

beforeEach(() => {
  mockDbExecute.mockClear();
  mockWithWriteDb.mockClear();
  // Reset the withWriteDb implementation to default.
  mockWithWriteDb.mockImplementation(
    async (cb: (db: { execute: typeof mockDbExecute }) => Promise<void>) =>
      cb({ execute: mockDbExecute }),
  );
  // Restore withWriteDb to default if a test overrode it.
  mockRequireServiceKey.mockClear();
  mockGetAgent.mockClear();
  // Restore getAgent to default (valid agent) — tests that need 404 override explicitly.
  mockGetAgent.mockImplementation(async (_agentId: string, _orgId: string) => ({
    id: _agentId,
    name: "test-agent",
    bridge_url: null,
    status: "running",
  }));
  mockLoggerInfo.mockClear();
  mockLoggerWarn.mockClear();
  mockLoggerError.mockClear();
  mockFailureResponse.mockClear();
  mockFailureResponse.mockImplementation((_c: unknown, _error: unknown) =>
    Response.json({ success: false, error: "internal" }, { status: 500 }),
  );
  requireServiceKeyImpl = null;
  requireServiceKeyThrows = null;
});

// ═══════════════════════════════════════════════════════════════════════════
// Auth
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/eliza/agents/:agentId/write — auth", () => {
  test("returns 500 via failureResponse when requireServiceKey throws (generic catch path)", async () => {
    requireServiceKeyThrows = new Error("Unauthorized");
    const app = makeApp();
    const res = await app.fetch(writeRequest("agent-1", validWrite()));
    expect(res.status).toBe(500); // caught by generic catch → failureResponse
  });

  test("returns 200 when service key is valid", async () => {
    requireServiceKeyImpl = () => ({ organizationId: "org-1" });
    mockGetAgent.mockResolvedValue({
      id: "agent-1",
      name: "test-agent",
      bridge_url: null,
      status: "running",
    });

    const app = makeApp();
    const res = await app.fetch(writeRequest("agent-1", validWrite()));
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/eliza/agents/:agentId/write — validation", () => {
  test("rejects non-JSON body", async () => {
    requireServiceKeyImpl = () => ({ organizationId: "org-1" });
    const app = makeApp();
    const req = new Request("http://localhost/v1/eliza/agents/agent-1/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json {{{",
    });
    const res = await app.fetch(req);
    // Should fail — json parse returns null → schema validation fails.
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
  });

  test("rejects missing writes array", async () => {
    requireServiceKeyImpl = () => ({ organizationId: "org-1" });
    const app = makeApp();
    const res = await app.fetch(writeRequest("agent-1", { notWrites: true }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain("Invalid write request");
  });

  test("rejects empty writes array", async () => {
    requireServiceKeyImpl = () => ({ organizationId: "org-1" });
    const app = makeApp();
    const res = await app.fetch(writeRequest("agent-1", { writes: [] }));
    expect(res.status).toBe(400);
  });

  test("rejects writes array with more than 100 entries", async () => {
    requireServiceKeyImpl = () => ({ organizationId: "org-1" });
    const app = makeApp();
    const oversized = {
      writes: Array.from({ length: 101 }, (_, i) => ({
        table: "memories",
        operation: "insert",
        row: { id: `id-${i}` },
        writeId: `write-${i}`,
      })),
    };
    const res = await app.fetch(writeRequest("agent-1", oversized));
    expect(res.status).toBe(400);
  });

  test("rejects invalid table name", async () => {
    requireServiceKeyImpl = () => ({ organizationId: "org-1" });
    mockGetAgent.mockResolvedValue({
      id: "agent-1",
      name: "test",
      bridge_url: null,
      status: "running",
    });
    const app = makeApp();
    const res = await app.fetch(
      writeRequest("agent-1", validWrite({ table: "not_a_real_table" })),
    );
    expect(res.status).toBe(400);
  });

  test("rejects invalid operation", async () => {
    requireServiceKeyImpl = () => ({ organizationId: "org-1" });
    mockGetAgent.mockResolvedValue({
      id: "agent-1",
      name: "test",
      bridge_url: null,
      status: "running",
    });
    const app = makeApp();
    const res = await app.fetch(
      writeRequest("agent-1", validWrite({ operation: "truncate" as string })),
    );
    expect(res.status).toBe(400);
  });

  test("rejects missing writeId", async () => {
    requireServiceKeyImpl = () => ({ organizationId: "org-1" });
    mockGetAgent.mockResolvedValue({
      id: "agent-1",
      name: "test",
      bridge_url: null,
      status: "running",
    });
    const app = makeApp();
    const body = {
      writes: [
        {
          table: "memories",
          operation: "insert",
          row: { id: "id-1" },
          // writeId intentionally omitted
        },
      ],
    };
    const res = await app.fetch(writeRequest("agent-1", body));
    expect(res.status).toBe(400);
  });

  test("rejects write with empty row", async () => {
    requireServiceKeyImpl = () => ({ organizationId: "org-1" });
    mockGetAgent.mockResolvedValue({
      id: "agent-1",
      name: "test",
      bridge_url: null,
      status: "running",
    });

    // Empty row slips past zod (record of string→unknown, min 0 by default),
    // but buildSQL throws. We'll mock withWriteDb to verify the SQL step
    // receives the error.
    const app = makeApp();
    const body = {
      writes: [
        {
          table: "memories",
          operation: "insert",
          row: {},
          writeId: "write-1",
        },
      ],
    };
    const res = await app.fetch(writeRequest("agent-1", body));
    // Empty row causes buildSQL to throw → error status per write.
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      results: Array<{ status: string; writeId: string }>;
    };
    expect(json.success).toBe(true);
    expect(json.results[0]!.status).toBe("error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Agent ownership
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/eliza/agents/:agentId/write — agent ownership", () => {
  test("returns 404 when agent is not found under the service org", async () => {
    requireServiceKeyImpl = () => ({ organizationId: "org-1" });
    mockGetAgent.mockResolvedValue(
      undefined as unknown as {
        id: string;
        name: string;
        bridge_url: null;
        status: string;
      },
    );
    const app = makeApp();
    const res = await app.fetch(writeRequest("unknown-agent", validWrite()));
    expect(res.status).toBe(404);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain("not found");
  });

  test("proceeds when agent exists under the service org", async () => {
    requireServiceKeyImpl = () => ({ organizationId: "org-1" });
    mockGetAgent.mockResolvedValue({
      id: "agent-1",
      name: "test-agent",
      bridge_url: null,
      status: "running",
    });

    const app = makeApp();
    const res = await app.fetch(writeRequest("agent-1", validWrite()));
    expect(res.status).toBe(200);
    // Verify getAgent was called with the correct params.
    expect(mockGetAgent).toHaveBeenCalledTimes(1);
    const getAgentCalls = mockGetAgent.mock.calls as unknown as [
      string,
      string,
    ][];
    expect(getAgentCalls[0]![0]).toBe("agent-1");
    expect(getAgentCalls[0]![1]).toBe("org-1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Write execution (SQL generation)
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/eliza/agents/:agentId/write — write execution", () => {
  beforeEach(() => {
    requireServiceKeyImpl = () => ({ organizationId: "org-1" });
    mockGetAgent.mockResolvedValue({
      id: "agent-1",
      name: "test-agent",
      bridge_url: null,
      status: "running",
    });
    mockDbExecute.mockClear();
    mockWithWriteDb.mockClear();
    mockWithWriteDb.mockImplementation(
      async (cb: (db: { execute: typeof mockDbExecute }) => Promise<void>) =>
        cb({ execute: mockDbExecute }),
    );
  });

  test("inserts a memory row", async () => {
    const app = makeApp();
    const body = validWrite({
      table: "memories",
      operation: "insert",
      row: {
        id: "mem-1",
        type: "test",
        agent_id: "agent-1",
        content: JSON.stringify({ text: "hello" }),
      },
    });

    const res = await app.fetch(writeRequest("agent-1", body));
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      results: Array<{ writeId: string; status: string }>;
    };
    expect(json.success).toBe(true);
    expect(json.results).toHaveLength(1);
    expect(json.results[0]!.writeId).toBe("write-1");
    expect(json.results[0]!.status).toBe("ok");

    // Verify withWriteDb was called.
    expect(mockWithWriteDb).toHaveBeenCalledTimes(1);
  });

  test("upserts an agent row", async () => {
    const app = makeApp();
    const body = validWrite({
      table: "agents",
      operation: "upsert",
      row: {
        id: "agent-1",
        name: "updated-name",
        updated_at: new Date().toISOString(),
      },
    });

    const res = await app.fetch(writeRequest("agent-1", body));
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      results: Array<{ status: string }>;
    };
    expect(json.results[0]!.status).toBe("ok");
  });

  test("deletes a room row", async () => {
    const app = makeApp();
    const body = validWrite({
      table: "rooms",
      operation: "delete",
      row: { id: "room-1" },
    });

    const res = await app.fetch(writeRequest("agent-1", body));
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      results: Array<{ status: string }>;
    };
    expect(json.results[0]!.status).toBe("ok");
  });

  test("processes batched writes for multiple tables", async () => {
    const app = makeApp();
    const body = {
      writes: [
        {
          table: "memories",
          operation: "insert",
          row: {
            id: "mem-1",
            type: "test",
            agent_id: "agent-1",
            content: "{}",
          },
          writeId: "w-1",
        },
        {
          table: "rooms",
          operation: "insert",
          row: {
            id: "room-1",
            agent_id: "agent-1",
            name: "test-room",
            source: "test",
            type: "GROUP",
          },
          writeId: "w-2",
        },
        {
          table: "entities",
          operation: "insert",
          row: { id: "entity-1", agent_id: "agent-1", name: "test-entity" },
          writeId: "w-3",
        },
        {
          table: "relationships",
          operation: "upsert",
          row: {
            id: "rel-1",
            agent_id: "agent-1",
            source_entity_id: "entity-1",
            target_entity_id: "entity-2",
          },
          writeId: "w-4",
        },
        {
          table: "tasks",
          operation: "upsert",
          row: {
            id: "task-1",
            name: "test-task",
            agent_id: "agent-1",
            updated_at: new Date().toISOString(),
          },
          writeId: "w-5",
        },
      ],
    };

    const res = await app.fetch(writeRequest("agent-1", body));
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      results: Array<{ writeId: string; status: string }>;
    };
    expect(json.success).toBe(true);
    expect(json.results).toHaveLength(5);
    for (const r of json.results) {
      expect(r.status).toBe("ok");
    }
  });

  test("accepts all 8 valid sync tables", async () => {
    const app = makeApp();
    const tables = [
      "agents",
      "entities",
      "worlds",
      "rooms",
      "participants",
      "memories",
      "relationships",
      "tasks",
    ];

    for (const table of tables) {
      const body = validWrite({
        table,
        operation: "insert",
        row: { id: `id-${table}`, agent_id: "agent-1" },
        writeId: `write-${table}`,
      });
      const res = await app.fetch(writeRequest("agent-1", body));
      expect(res.status).toBe(200);
    }
  });

  test("rejects user_sessions table (intentionally excluded)", async () => {
    const app = makeApp();
    const body = validWrite({
      table: "user_sessions",
      operation: "insert",
      row: {
        id: "session-1",
        user_id: "user-1",
        session_token: "token-1",
      },
    });

    const res = await app.fetch(writeRequest("agent-1", body));
    expect(res.status).toBe(400);
  });

  test("DELETE without id column reports error", async () => {
    const app = makeApp();
    const body = {
      writes: [
        {
          table: "memories",
          operation: "delete",
          row: { not_id: "something" },
          writeId: "w-1",
        },
      ],
    };

    const res = await app.fetch(writeRequest("agent-1", body));
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      results: Array<{ status: string; error?: string }>;
    };
    expect(json.results[0]!.status).toBe("error");
    expect(json.results[0]!.error).toContain("DELETE requires an id");
  });

  test("upsert with only id column reports error", async () => {
    const app = makeApp();
    const body = {
      writes: [
        {
          table: "agents",
          operation: "upsert",
          row: { id: "agent-1" },
          writeId: "w-1",
        },
      ],
    };

    const res = await app.fetch(writeRequest("agent-1", body));
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      results: Array<{ status: string; error?: string }>;
    };
    expect(json.results[0]!.status).toBe("error");
    expect(json.results[0]!.error).toContain(
      "requires at least one non-id column",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Error handling
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/eliza/agents/:agentId/write — error handling", () => {
  beforeEach(() => {
    requireServiceKeyImpl = () => ({ organizationId: "org-1" });
    mockGetAgent.mockResolvedValue({
      id: "agent-1",
      name: "test-agent",
      bridge_url: null,
      status: "running",
    });
    mockDbExecute.mockClear();
    mockWithWriteDb.mockClear();
    mockWithWriteDb.mockImplementation(
      async (cb: (db: { execute: typeof mockDbExecute }) => Promise<void>) =>
        cb({ execute: mockDbExecute }),
    );
  });

  test("reports individual write failures as 'error' status", async () => {
    mockWithWriteDb.mockImplementation(
      async (cb: (db: { execute: typeof mockDbExecute }) => Promise<void>) => {
        await cb({ execute: mockDbExecute });
      },
    );
    // First call passes, second call throws.
    mockDbExecute.mockImplementationOnce(async () => {});
    mockDbExecute.mockImplementationOnce(async () => {
      throw new Error("syntax error");
    });

    const app = makeApp();
    const body = {
      writes: [
        {
          table: "memories",
          operation: "insert",
          row: {
            id: "mem-1",
            type: "test",
            agent_id: "agent-1",
            content: "{}",
          },
          writeId: "w-ok",
        },
        {
          table: "rooms",
          operation: "insert",
          row: {
            id: "room-1",
            agent_id: "agent-1",
            name: "bad",
            source: "test",
            type: "GROUP",
          },
          writeId: "w-fail",
        },
      ],
    };

    const res = await app.fetch(writeRequest("agent-1", body));
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      results: Array<{ writeId: string; status: string; error?: string }>;
    };
    expect(json.success).toBe(true);
    expect(json.results[0]!.status).toBe("ok");
    expect(json.results[0]!.writeId).toBe("w-ok");
    expect(json.results[1]!.status).toBe("error");
    expect(json.results[1]!.writeId).toBe("w-fail");
    expect(json.results[1]!.error).toBeTruthy();
  });

  test("classifies constraint violations as 'conflict'", async () => {
    mockWithWriteDb.mockImplementation(
      async (cb: (db: { execute: typeof mockDbExecute }) => Promise<void>) => {
        await cb({ execute: mockDbExecute });
      },
    );
    mockDbExecute.mockImplementation(async () => {
      throw new Error("duplicate key value violates unique constraint");
    });

    const app = makeApp();
    const body = validWrite();

    const res = await app.fetch(writeRequest("agent-1", body));
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      results: Array<{ status: string; error?: string }>;
    };
    expect(json.results[0]!.status).toBe("conflict");
    // Conflict errors should NOT expose the raw DB error to the client.
    expect(json.results[0]!.error).toBeUndefined();
  });

  test("classifies ON CONFLICT errors containing 'conflict' as 'conflict'", async () => {
    mockWithWriteDb.mockImplementation(
      async (cb: (db: { execute: typeof mockDbExecute }) => Promise<void>) => {
        await cb({ execute: mockDbExecute });
      },
    );
    mockDbExecute.mockImplementation(async () => {
      throw new Error("duplicate key conflict — ON CONFLICT resolution failed");
    });

    const app = makeApp();
    const res = await app.fetch(writeRequest("agent-1", validWrite()));
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      results: Array<{ status: string }>;
    };
    expect(json.results[0]!.status).toBe("conflict");
  });

  test("generic catch returns 500 via failureResponse", async () => {
    // Simulate a totally unexpected error by making requireServiceKey throw
    // a non-auth error (e.g., a runtime crash).
    requireServiceKeyThrows = new Error("boom — something broke");
    mockFailureResponse.mockImplementation((_c, _err) =>
      Response.json({ success: false, error: "internal" }, { status: 500 }),
    );

    const app = makeApp();
    const res = await app.fetch(writeRequest("agent-1", validWrite()));
    expect(res.status).toBe(500);
  });

  test("loggers fire for both successes and failures", async () => {
    mockLoggerInfo.mockClear();
    mockLoggerWarn.mockClear();

    mockWithWriteDb.mockImplementation(
      async (cb: (db: { execute: typeof mockDbExecute }) => Promise<void>) => {
        await cb({ execute: mockDbExecute });
      },
    );
    // First write succeeds, second fails.
    mockDbExecute.mockImplementationOnce(async () => {});
    mockDbExecute.mockImplementationOnce(async () => {
      throw new Error("bad things");
    });

    const app = makeApp();
    const body = {
      writes: [
        {
          table: "memories",
          operation: "insert",
          row: {
            id: "mem-1",
            type: "test",
            agent_id: "agent-1",
            content: "{}",
          },
          writeId: "w-ok",
        },
        {
          table: "rooms",
          operation: "insert",
          row: {
            id: "room-1",
            agent_id: "agent-1",
            name: "bad",
            source: "test",
            type: "GROUP",
          },
          writeId: "w-fail",
        },
      ],
    };

    await app.fetch(writeRequest("agent-1", body));

    // The info logger should fire for the batch summary.
    expect(mockLoggerInfo).toHaveBeenCalled();
    // The warn logger should fire for the failed write.
    expect(mockLoggerWarn).toHaveBeenCalled();
  });
});
