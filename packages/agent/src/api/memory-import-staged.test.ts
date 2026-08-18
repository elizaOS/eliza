/**
 * Deterministic tests for the staged sealed importer: seal trust, batch
 * geometry, staging completeness, digest binding to the ORIGINAL seal,
 * dimension negotiation, id-conflict semantics, and the atomic publish
 * ordering (verify → scaffold → publish → drain, all inside one
 * transaction). The database is a scripted double that records every
 * statement; real SQL behavior is covered by the pglite suites.
 */
import { describe, expect, test } from "bun:test";
import {
  computeSharedMemoryTransferDigest,
  type SealedMemoryExportRow,
  signSeal,
} from "@elizaos/shared/contracts/shared-memory-transfer";
import {
  finalizeSealedImport,
  MEMORY_IMPORT_BATCH_INVALID,
  MEMORY_IMPORT_DIGEST_MISMATCH,
  MEMORY_IMPORT_DIMENSION_UNSUPPORTED,
  MEMORY_IMPORT_ID_CONFLICT,
  MEMORY_IMPORT_SEAL_INVALID,
  MEMORY_IMPORT_STAGING_INCOMPLETE,
  stageSealedBatch,
} from "./memory-import-staged.ts";

const KEY = "test-seal-key";
const AGENT = "77000000-0000-4000-8000-000000000001";

function row(
  i: number,
  overrides: Partial<SealedMemoryExportRow> = {},
): SealedMemoryExportRow {
  return {
    id: `66000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    type: "messages",
    created_at: new Date(1700000000000 + i * 1000).toISOString(),
    content: { text: `memory ${i}` },
    entity_id: null,
    agent_id: AGENT,
    room_id: "55000000-0000-4000-8000-000000000001",
    world_id: "44000000-0000-4000-8000-000000000001",
    unique: false,
    metadata: {},
    embedding: Array.from({ length: 384 }, (_, k) => ((i + k) % 7) / 7),
    ...overrides,
  };
}

async function sealFor(
  rows: SealedMemoryExportRow[],
  dimension: number | null = 384,
) {
  const digest = await computeSharedMemoryTransferDigest(rows);
  const body = {
    version: 3 as const,
    epoch: 1,
    source_agent_id: AGENT,
    scope: "org:user:agent",
    row_count: rows.length,
    digest,
    vector_dimension: dimension,
    exported_at: new Date(1700000000000).toISOString(),
  };
  return { ...body, signature: await signSeal(body, KEY) };
}

interface ScriptedDb {
  statements: string[];
  transactions: number;
  stagedRows: SealedMemoryExportRow[];
  existing: Array<Record<string, unknown>>;
  /** When set, staging inserts conflict and this payload is the kept row. */
  replayKept?: unknown;
}

function scriptedRuntime(script: Partial<ScriptedDb> = {}) {
  const state: ScriptedDb = {
    statements: [],
    transactions: 0,
    stagedRows: script.stagedRows ?? [],
    existing: script.existing ?? [],
    ...script,
  };
  const exec = async (q: unknown) => {
    const text = JSON.stringify(q);
    state.statements.push(text);
    if (text.includes("INSERT INTO memory_import_staging")) {
      return { rows: state.replayKept ? [] : [{ row_id: "x" }] };
    }
    if (text.includes("SELECT payload FROM memory_import_staging") && text.includes("row_id =")) {
      return { rows: [{ payload: state.replayKept }] };
    }
    if (text.includes("SELECT payload FROM memory_import_staging")) {
      return { rows: state.stagedRows.map((payload) => ({ payload })) };
    }
    if (text.includes("FROM memories")) {
      return { rows: state.existing };
    }
    if (text.includes("count(*)")) {
      return { rows: [{ n: state.stagedRows.length }] };
    }
    return { rows: [] };
  };
  const db = {
    execute: exec,
    transaction: async <T>(
      fn: (tx: { execute: typeof exec }) => Promise<T>,
    ) => {
      state.transactions += 1;
      return fn({ execute: exec });
    },
  };
  const runtime = {
    agentId: AGENT,
    db,
    getSetting: (name: string) =>
      name === "ELIZA_MEMORY_TRANSFER_SEAL_KEY" ? KEY : undefined,
  } as never;
  return { runtime, state };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
}

describe("stageSealedBatch", () => {
  test("rejects a seal signed with a different key", async () => {
    const rows = [row(1)];
    const seal = { ...(await sealFor(rows)), signature: "0".repeat(64) };
    const { runtime } = scriptedRuntime();
    await expectCode(
      stageSealedBatch(runtime, { seal, batch_index: 0, batch_count: 1, rows }),
      MEMORY_IMPORT_SEAL_INVALID,
    );
  });

  test("rejects batch geometry that does not match the seal", async () => {
    const rows = [row(1)];
    const seal = await sealFor(rows);
    const { runtime } = scriptedRuntime();
    await expectCode(
      stageSealedBatch(runtime, { seal, batch_index: 0, batch_count: 4, rows }),
      MEMORY_IMPORT_BATCH_INVALID,
    );
  });

  test("stages rows idempotently and reports totals", async () => {
    const rows = [row(1), row(2)];
    const seal = await sealFor(rows);
    const { runtime, state } = scriptedRuntime({ stagedRows: rows });
    const out = await stageSealedBatch(runtime, {
      seal,
      batch_index: 0,
      batch_count: 1,
      rows,
    });
    expect(out).toEqual({ staged: 2, total_staged: 2 });
    expect(
      state.statements.filter((s) =>
        s.includes("ON CONFLICT (seal_digest, row_id) DO NOTHING"),
      ),
    ).toHaveLength(2);
  });
});

function asExisting(r: SealedMemoryExportRow, overrides: Record<string, unknown> = {}) {
  return {
    id: r.id,
    type: r.type,
    created_at: r.created_at,
    content: r.content,
    entity_id: r.entity_id,
    room_id: r.room_id,
    world_id: r.world_id,
    unique: r.unique,
    metadata: r.metadata,
    ...overrides,
  };
}

describe("stageSealedBatch conflicting replay", () => {
  test("byte-identical replay is idempotent; differing payload is a typed error", async () => {
    const rows = [row(1)];
    const seal = await sealFor(rows);
    const kept = scriptedRuntime({ replayKept: JSON.stringify(rows[0]) });
    await stageSealedBatch(kept.runtime, { seal, batch_index: 0, batch_count: 1, rows });
    const conflicting = scriptedRuntime({
      replayKept: JSON.stringify(row(1, { content: { text: "swapped" } })),
    });
    await expectCode(
      stageSealedBatch(conflicting.runtime, { seal, batch_index: 0, batch_count: 1, rows }),
      MEMORY_IMPORT_BATCH_INVALID,
    );
  });
});

describe("finalizeSealedImport", () => {
  test("refuses an unsupported vector dimension before touching the db", async () => {
    const rows = [row(1)];
    const seal = await sealFor(rows, 999);
    const { runtime, state } = scriptedRuntime({ stagedRows: rows });
    await expectCode(
      finalizeSealedImport(runtime, { seal }),
      MEMORY_IMPORT_DIMENSION_UNSUPPORTED,
    );
    expect(state.transactions).toBe(0);
  });

  test("fails closed when staging does not cover the seal", async () => {
    const rows = [row(1), row(2)];
    const seal = await sealFor(rows, 384);
    const { runtime } = scriptedRuntime({ stagedRows: rows.slice(0, 1) });
    await expectCode(
      finalizeSealedImport(runtime, { seal }),
      MEMORY_IMPORT_STAGING_INCOMPLETE,
    );
  });

  test("binds finalization to the ORIGINAL digest — tampered rows fail", async () => {
    const rows = [row(1)];
    const seal = await sealFor(rows, 384);
    const tampered = [row(1, { content: { text: "swapped" } })];
    const { runtime } = scriptedRuntime({ stagedRows: tampered });
    await expectCode(
      finalizeSealedImport(runtime, { seal }),
      MEMORY_IMPORT_DIGEST_MISMATCH,
    );
  });

  test("conflicting existing id fails the whole finalize", async () => {
    const rows = [row(1)];
    const seal = await sealFor(rows, 384);
    const { runtime } = scriptedRuntime({
      stagedRows: rows,
      existing: [asExisting(row(1), { content: { text: "different" } })],
    });
    await expectCode(
      finalizeSealedImport(runtime, { seal }),
      MEMORY_IMPORT_ID_CONFLICT,
    );
  });

  test("publishes atomically: scaffold, rows, vectors, drain in one transaction", async () => {
    const rows = [row(1), row(2)];
    const seal = await sealFor(rows, 384);
    const { runtime, state } = scriptedRuntime({ stagedRows: rows });
    const out = await finalizeSealedImport(runtime, { seal });
    expect(out).toEqual({ published: 2, skipped_existing: 0 });
    expect(state.transactions).toBe(1);
    const joined = state.statements.join("\n");
    expect(joined).toContain("INSERT INTO worlds");
    expect(joined).toContain("INSERT INTO rooms");
    expect(joined).toContain("INSERT INTO memories");
    expect(joined).toContain("dim_384");
    expect(joined).toContain("DELETE FROM memory_import_staging");
    const memInserts = state.statements.filter((s) =>
      s.includes("INSERT INTO memories"),
    );
    expect(memInserts).toHaveLength(2);
  });

  test("same content in a different room is a conflict, not a skip", async () => {
    const rows = [row(1)];
    const seal = await sealFor(rows, 384);
    const { runtime } = scriptedRuntime({
      stagedRows: rows,
      existing: [asExisting(row(1), { room_id: "55000000-0000-4000-8000-000000000099" })],
    });
    await expectCode(finalizeSealedImport(runtime, { seal }), MEMORY_IMPORT_ID_CONFLICT);
  });

  test("hash-identical existing rows are skipped, not conflicts", async () => {
    const rows = [row(1), row(2)];
    const seal = await sealFor(rows, 384);
    const { runtime, state } = scriptedRuntime({
      stagedRows: rows,
      existing: [asExisting(row(1))],
    });
    const out = await finalizeSealedImport(runtime, { seal });
    expect(out).toEqual({ published: 1, skipped_existing: 1 });
    expect(
      state.statements.filter((s) => s.includes("INSERT INTO memories")),
    ).toHaveLength(1);
  });
});
