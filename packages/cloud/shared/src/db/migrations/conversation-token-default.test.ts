/** Applies migration 0308 to real PGlite and proves implicit caps are removed without rewriting explicit settings. */
import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await Bun.file(
  new URL("./0308_remove_conversation_token_default.sql", import.meta.url),
).text();
const databases: PGlite[] = [];

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`CREATE TABLE conversations (
    id text PRIMARY KEY,
    settings jsonb NOT NULL DEFAULT '{"temperature":0.7,"maxTokens":2000,"topP":1,"frequencyPenalty":0,"presencePenalty":0,"systemPrompt":"You are a helpful AI assistant."}'::jsonb
  )`);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0308 conversation output default", () => {
  test("removes only the exact implicit cap and leaves explicit settings intact", async () => {
    const db = await database();
    await db.exec(`
      INSERT INTO conversations (id) VALUES ('implicit');
      INSERT INTO conversations (id, settings) VALUES
        ('explicit-2000', '{"temperature":0.2,"maxTokens":2000}'::jsonb),
        ('explicit-1000', '{"maxTokens":1000}'::jsonb),
        ('already-uncapped', '{"temperature":0.7}'::jsonb);
    `);

    await db.exec(migration);
    await db.exec(migration);
    await db.exec("INSERT INTO conversations (id) VALUES ('new-default')");

    const result = await db.query<{ id: string; settings: Record<string, unknown> }>(
      "SELECT id, settings FROM conversations ORDER BY id",
    );
    expect(result.rows).toEqual([
      { id: "already-uncapped", settings: { temperature: 0.7 } },
      { id: "explicit-1000", settings: { maxTokens: 1000 } },
      {
        id: "explicit-2000",
        settings: { maxTokens: 2000, temperature: 0.2 },
      },
      {
        id: "implicit",
        settings: {
          frequencyPenalty: 0,
          presencePenalty: 0,
          systemPrompt: "You are a helpful AI assistant.",
          temperature: 0.7,
          topP: 1,
        },
      },
      {
        id: "new-default",
        settings: {
          frequencyPenalty: 0,
          presencePenalty: 0,
          systemPrompt: "You are a helpful AI assistant.",
          temperature: 0.7,
          topP: 1,
        },
      },
    ]);
  });
});
