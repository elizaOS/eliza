/** Real document graph publication and deletion over the owning repository. */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

const postgresDatabase = process.env.DOCUMENT_PUBLICATION_TEST_POSTGRES_URL;
if (postgresDatabase) {
  const parsed = new URL(postgresDatabase);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    !parsed.username.startsWith("qa_") ||
    !/^\/quint_document_[a-f0-9]+$/.test(parsed.pathname)
  )
    throw new Error(
      "Document PostgreSQL tests require an isolated local qa_* quint_document_* database",
    );
}
process.env.DATABASE_URL = postgresDatabase ?? "pglite://memory";
process.env.TEST_DATABASE_URL = postgresDatabase ?? "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const user = {
  id: randomUUID(),
  organization_id: randomUUID(),
  email: "owner@example.test",
};
const scope = { agentId: user.id, roomId: user.id };
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserOrApiKeyWithOrg: async () => user,
}));
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    RateLimitPresets: { STANDARD: {} },
    rateLimit: () => async (_context: unknown, next: () => Promise<void>) =>
      next(),
  }),
);

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { agentTable, entityTable, memoryTable, roomTable } = await import(
  "@elizaos/cloud-shared/db/schemas"
);
const { memoriesRepository } = await import(
  "@elizaos/cloud-shared/db/repositories/agents/memories"
);
const { createDocumentRecord } = await import(
  "../v1/documents/_worker-documents"
);
const { default: documentRoute } = await import("../v1/documents/[id]/route");
const app = new Hono().route("/documents/:id", documentRoute);
const text = `${"a".repeat(3999)}😀${"b".repeat(5000)}`;
const input = {
  filename: "complete.txt",
  contentType: "text/plain",
  size: text.length,
  text,
};

beforeAll(async () => {
  const { apply } = await pushSchema(
    { agentTable, entityTable, roomTable, memoryTable } as never,
    dbWrite as never,
  );
  await apply();
}, 120_000);
beforeEach(async () => {
  await dbWrite.execute(
    sql`DROP TRIGGER IF EXISTS controlled_document_failure ON memories`,
  );
  await dbWrite.execute(sql`DROP FUNCTION IF EXISTS reject_document_write()`);
  await dbWrite.delete(memoryTable);
});
afterAll(async () => {
  mock.restore();
  await closeDatabaseConnectionsForTests();
});

async function graph() {
  return dbWrite
    .select({ id: memoryTable.id, type: memoryTable.type })
    .from(memoryTable);
}

function fields(value: unknown): Record<string, unknown> {
  const isRecord = (entry: unknown): entry is Record<string, unknown> =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry);
  if (!isRecord(value)) throw new Error("Expected stored document fields");
  return value;
}

test("document publication retains complete text and every ordered fragment", async () => {
  const document = await createDocumentRecord(user as never, scope, input);
  expect(document.content.text).toBe(text);
  const rows = await dbWrite.select().from(memoryTable);
  const fragments = rows
    .filter((row) => row.type === "document_fragments")
    .map((row) => ({
      ...row,
      metadata: fields(row.metadata),
      content: fields(row.content),
    }));
  const ordered = fragments.sort(
    (left, right) =>
      Number(left.metadata.position) - Number(right.metadata.position),
  );
  expect(ordered).toHaveLength(3);
  expect(ordered.map((row) => row.content.text).join("")).toBe(text);
  expect(
    ordered.every(
      (row) => row.agentId === scope.agentId && row.roomId === scope.roomId,
    ),
  ).toBe(true);
  expect(ordered.every((row) => row.metadata.documentId === document.id)).toBe(
    true,
  );
  expect(ordered.map((row) => row.metadata.position)).toEqual([0, 1, 2]);
  expect(ordered.every((row) => row.metadata.type === "fragment")).toBe(true);
  const originalMetadata: Record<string, unknown> = {
    ...fields(document.metadata),
    type: "fragment",
  };
  for (const row of ordered) {
    expect(row.metadata).toEqual({
      ...originalMetadata,
      documentId: document.id,
      position: row.metadata.position,
    });
  }
  expect(originalMetadata.timestamp).toBe(originalMetadata.uploadedAt);
  expect(typeof originalMetadata.timestamp).toBe("number");
});

test("fragment failure rolls back the parent and the whole fragment batch", async () => {
  await dbWrite.execute(
    sql`CREATE FUNCTION reject_document_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'document_fragments' AND NEW.metadata->>'position' = '256' THEN RAISE EXCEPTION 'controlled fragment failure'; END IF; RETURN NEW; END $$`,
  );
  await dbWrite.execute(
    sql`CREATE TRIGGER controlled_document_failure BEFORE INSERT ON memories FOR EACH ROW EXECUTE FUNCTION reject_document_write()`,
  );
  await expect(
    createDocumentRecord(user as never, scope, {
      ...input,
      text: "complete".repeat(129_000),
    }),
  ).rejects.toMatchObject({
    cause: { code: "P0001" },
  });
  expect(await graph()).toEqual([]);
});

test("parent deletion failure rolls back fragment deletion through the real route", async () => {
  const document = await createDocumentRecord(user as never, scope, input);
  const before = await graph();
  await dbWrite.execute(
    sql`CREATE FUNCTION reject_document_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.type = 'documents' THEN RAISE EXCEPTION 'controlled parent delete failure'; END IF; RETURN OLD; END $$`,
  );
  await dbWrite.execute(
    sql`CREATE TRIGGER controlled_document_failure BEFORE DELETE ON memories FOR EACH ROW EXECUTE FUNCTION reject_document_write()`,
  );
  expect(
    (await app.request(`/documents/${document.id}`, { method: "DELETE" }))
      .status,
  ).toBe(500);
  expect((await graph()).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
    before.sort((a, b) => a.id.localeCompare(b.id)),
  );
});

test("a suppressed parent deletion rolls back fragment deletion through the real route", async () => {
  const document = await createDocumentRecord(user as never, scope, input);
  const before = await graph();
  await dbWrite.execute(
    sql`CREATE FUNCTION reject_document_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.type = 'documents' THEN RETURN NULL; END IF; RETURN OLD; END $$`,
  );
  await dbWrite.execute(
    sql`CREATE TRIGGER controlled_document_failure BEFORE DELETE ON memories FOR EACH ROW EXECUTE FUNCTION reject_document_write()`,
  );
  expect(
    (await app.request(`/documents/${document.id}`, { method: "DELETE" }))
      .status,
  ).toBe(500);
  expect((await graph()).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
    before.sort((a, b) => a.id.localeCompare(b.id)),
  );
});

test("document deletion removes its whole graph and a second request reports absence", async () => {
  const document = await createDocumentRecord(user as never, scope, input);
  expect(
    (await app.request(`/documents/${document.id}`, { method: "DELETE" }))
      .status,
  ).toBe(200);
  expect(await graph()).toEqual([]);
  expect(
    (await app.request(`/documents/${document.id}`, { method: "DELETE" }))
      .status,
  ).toBe(404);
});

test("a foreign document scope cannot delete the parent or its fragments", async () => {
  const document = await createDocumentRecord(user as never, scope, input);
  const before = await graph();
  expect(
    await memoriesRepository.deleteDocument(document.id, {
      agentId: randomUUID(),
      roomId: randomUUID(),
    }),
  ).toBe(false);
  expect(await graph()).toEqual(before);
});

// The PostgreSQL interleaving suite reuses these exact six tests and the same
// production route/repository fixture. Authentication remains a supplied owner.
export {
  app,
  createDocumentRecord,
  dbWrite,
  graph,
  input,
  memoriesRepository,
  memoryTable,
  scope,
  user,
};
