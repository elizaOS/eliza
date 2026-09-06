/**
 * Exercises the shared progressive-content target lifecycle against a real
 * PostgreSQL database. The test is opt-in through POSTGRES_URL and observes
 * authorization, isolation, restart, and cleanup through target receipts.
 */

import { createHash, randomUUID } from "node:crypto";
import { runProgressiveContentTargetConformance } from "@elizaos/core/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProgressivePostgresSqlTargetFactories } from "../../testing/progressive-content-sql-targets";

const baseUrl = process.env.POSTGRES_URL;
const describePostgres = baseUrl ? describe : describe.skip;

function databaseUrl(connectionString: string, databaseName: string): string {
  const scoped = new URL(connectionString);
  scoped.pathname = `/${databaseName}`;
  scoped.searchParams.delete("options");
  return scoped.toString();
}

describePostgres("PostgreSQL progressive-content target factories", () => {
  const databaseName = `eliza_progressive_target_${randomUUID().replaceAll("-", "")}`;
  let bootstrap: Pool;
  let scopedUrl: string;

  beforeAll(async () => {
    if (!baseUrl) return;
    bootstrap = new Pool({ connectionString: baseUrl, max: 1 });
    await bootstrap.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0 ENCODING 'UTF8'`);
    scopedUrl = databaseUrl(baseUrl, databaseName);
  });

  afterAll(async () => {
    if (!baseUrl) return;
    await bootstrap.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await bootstrap.end();
  });

  it("derives lifecycle receipts from PostgreSQL reads and removes owned rows", async () => {
    const factories = await createProgressivePostgresSqlTargetFactories({
      connectionString: scopedUrl,
    });
    const factory = factories.find(({ family }) => family === "document");
    expect(factory).toBeDefined();
    const bytes = Buffer.from("real-postgres-content\n".repeat(6_000), "utf8");
    let sourceBytesRead = 0;
    const target = await factory!.create({
      object: {
        id: "postgres-document",
        family: "document",
        byteLength: bytes.byteLength,
        sourceSha256: createHash("sha256").update(bytes).digest("hex"),
        sourceRevision: "corpus-revision",
        format: "utf8",
        authorizationScope: "postgres-room",
        canaries: [],
      },
      source: {
        byteLength: bytes.byteLength,
        async read(offset, maxBytes = 64 * 1024) {
          const page = bytes.subarray(offset, Math.min(offset + maxBytes, bytes.byteLength));
          sourceBytesRead += page.byteLength;
          return page;
        },
      },
    });
    expect(sourceBytesRead).toBe(bytes.byteLength);

    const result = await runProgressiveContentTargetConformance({
      manifestSha256: createHash("sha256").update("manifest").digest("hex"),
      adapterId: factory!.adapterId,
      target,
    });
    expect(result.report.status).toBe("passed");
    expect(result.receipts.map(({ phase }) => phase)).toEqual(
      expect.arrayContaining(["realized", "authorization", "isolation", "restart", "cleanup"])
    );
    expect(result.receipts.every(({ status }) => status === "passed")).toBe(true);

    const probe = new Pool({ connectionString: scopedUrl, max: 1 });
    const remaining = await probe.query(
      "SELECT count(*)::int AS count FROM memories WHERE metadata->>'documentId' IS NOT NULL"
    );
    await probe.end();
    expect(Number(remaining.rows[0]?.count ?? -1)).toBe(0);
  }, 120_000);

  it("rejects declared binary before reading or writing", async () => {
    const factories = await createProgressivePostgresSqlTargetFactories({
      connectionString: scopedUrl,
    });
    const factory = factories.find(({ family }) => family === "memory");
    let reads = 0;
    await expect(
      factory!.create({
        object: {
          id: "postgres-binary",
          family: "memory",
          byteLength: 4,
          sourceSha256: createHash("sha256")
            .update(Buffer.from([0, 1, 2, 3]))
            .digest("hex"),
          sourceRevision: "corpus-revision",
          format: "binary",
          authorizationScope: "postgres-room",
          canaries: [],
        },
        source: {
          byteLength: 4,
          async read() {
            reads += 1;
            return Buffer.from([0, 1, 2, 3]);
          },
        },
      })
    ).rejects.toMatchObject({ code: "CONTENT_BINARY_UNSUPPORTED" });
    expect(reads).toBe(0);
  }, 120_000);
});
