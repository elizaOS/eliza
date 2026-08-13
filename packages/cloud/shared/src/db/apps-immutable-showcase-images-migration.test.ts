/**
 * Applies the known showcase image migration to real PGlite rows and proves it
 * preserves unrelated metadata while leaving unknown and pinned refs unchanged.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_PATH = join(import.meta.dir, "migrations/0199_apps_immutable_showcase_images.sql");
const EDAD_PINNED =
  "ghcr.io/elizaos/example-edad@sha256:2c68b639eec00fad1b35e978f5463f1543b392c96680ec496fd0c0a9eddc8241";
const CLONE_PINNED =
  "ghcr.io/elizaos/example-clone-ur-crush@sha256:b7e5fd1310a56158ea47ea923eccc7ae4ca067b177bea0cd326d32c4129b60db";

let client: PGlite;

async function applyMigration(): Promise<void> {
  for (const statement of readFileSync(MIGRATION_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((candidate) => candidate.trim())
    .filter(Boolean)) {
    await client.exec(statement);
  }
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE apps (
      id text PRIMARY KEY,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    INSERT INTO apps (id, metadata) VALUES
      ('edad', '{"imageTag":"ghcr.io/elizaos/example-edad:showcase","keep":"edad"}'),
      ('clone', '{"imageTag":"ghcr.io/elizaos/example-clone-ur-crush:showcase","keep":"clone"}'),
      ('unknown', '{"imageTag":"ghcr.io/elizaos/unknown:latest","keep":"unknown"}'),
      ('pinned', '{"imageTag":"${EDAD_PINNED}","keep":"pinned"}');
  `);
});

afterAll(async () => {
  await client.close();
});

describe("0199 apps immutable showcase images", () => {
  test("is registered in the migration journal", () => {
    const journal = JSON.parse(
      readFileSync(join(import.meta.dir, "migrations/meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };
    expect(
      journal.entries.some((entry) => entry.tag === "0199_apps_immutable_showcase_images"),
    ).toBe(true);
  });

  test("repins only known tags, preserves metadata, and is idempotent", async () => {
    await applyMigration();
    await applyMigration();

    const result = await client.query<{ id: string; metadata: Record<string, unknown> }>(
      "SELECT id, metadata FROM apps ORDER BY id",
    );
    expect(result.rows).toEqual([
      { id: "clone", metadata: { imageTag: CLONE_PINNED, keep: "clone" } },
      { id: "edad", metadata: { imageTag: EDAD_PINNED, keep: "edad" } },
      {
        id: "pinned",
        metadata: { imageTag: EDAD_PINNED, keep: "pinned" },
      },
      {
        id: "unknown",
        metadata: { imageTag: "ghcr.io/elizaos/unknown:latest", keep: "unknown" },
      },
    ]);
  });
});
