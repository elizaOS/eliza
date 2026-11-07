/**
 * Document text is stored again as 4000-character fragments in the jsonb
 * memories table. A fragment boundary inside a surrogate pair (an emoji)
 * leaves a lone half, which Postgres refuses as JSON text, so the upload
 * failed after its document row was written. Real createDocumentRecord and
 * memories repository over PGlite.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const ORG = "11111111-1111-4111-8111-1111111111c1";
const USER = "22222222-2222-4222-8222-2222222222c1";

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { agentTable, entityTable, memoryTable, roomTable } = await import(
  "@elizaos/cloud-shared/db/schemas"
);
const { eq } = await import("drizzle-orm");
const { createDocumentRecord } = await import(
  "../v1/documents/_worker-documents"
);

beforeAll(async () => {
  const { apply } = await pushSchema(
    { agentTable, entityTable, roomTable, memoryTable } as never,
    dbWrite as never,
  );
  await apply();
}, 120_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

test("an emoji on a fragment boundary is stored whole", async () => {
  // The emoji's two UTF-16 halves sit at offsets 3999 and 4000.
  const text = `${"a".repeat(3999)}😀 tail`;
  const document = await createDocumentRecord(
    { id: USER, organization_id: ORG, email: "owner@example.test" } as never,
    { agentId: USER, roomId: USER },
    {
      filename: "notes.txt",
      contentType: "text/plain",
      size: text.length,
      text,
    },
  );

  const fragments = await dbWrite
    .select({ content: memoryTable.content, metadata: memoryTable.metadata })
    .from(memoryTable)
    .where(eq(memoryTable.type, "document_fragments"));
  const ordered = fragments
    .filter(
      (row) =>
        (row.metadata as { documentId?: string }).documentId === document.id,
    )
    .sort(
      (left, right) =>
        (left.metadata as { position: number }).position -
        (right.metadata as { position: number }).position,
    )
    .map((row) => (row.content as { text: string }).text);
  expect(ordered).toEqual(["a".repeat(3999), "😀 tail"]);
});
