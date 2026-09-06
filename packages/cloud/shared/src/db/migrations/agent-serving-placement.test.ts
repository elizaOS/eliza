/** Exercises the additive serving-placement migration on existing rows in real isolated PGlite. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("serving placement migration preserves existing rows and can be replayed", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE agent_sandboxes (id integer PRIMARY KEY, original text NOT NULL); INSERT INTO agent_sandboxes VALUES (1, 'retained-state');",
    );
    const migration = await readFile(
      new URL("./0364_agent_serving_placement.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);
    const before = await db.query(
      "SELECT original, serving_placement FROM agent_sandboxes WHERE id = 1",
    );
    expect(before.rows).toEqual([{ original: "retained-state", serving_placement: null }]);
    await db.query("UPDATE agent_sandboxes SET serving_placement = $1::jsonb WHERE id = 1", [
      JSON.stringify({ version: 1, locator: { containerId: "a".repeat(64) } }),
    ]);
    await db.exec(migration);
    const after = await db.query(
      "SELECT original, serving_placement FROM agent_sandboxes WHERE id = 1",
    );
    expect(after.rows).toEqual([
      {
        original: "retained-state",
        serving_placement: { version: 1, locator: { containerId: "a".repeat(64) } },
      },
    ]);
  } finally {
    await db.close();
  }
}, 60_000);
