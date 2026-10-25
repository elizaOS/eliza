import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { repairPersonalConversation } from "./personal-conversation-repair";
import type { SharedTurnMessage } from "./shared-runtime/run-shared-agent-turn";

async function withStore(run: (db: PGlite) => Promise<void>) {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE messages (id text PRIMARY KEY, role text NOT NULL, content text NOT NULL, created_at double precision); CREATE TABLE conversations (id text PRIMARY KEY)",
    );
    await run(db);
  } finally {
    await db.close();
  }
}

const history: SharedTurnMessage[] = [
  { id: "first", role: "user", content: "A complete earlier fact: 東京 🌍", createdAt: 0 },
  { id: "second", role: "assistant", content: "Acknowledged without shortening.", createdAt: 1 },
];

test("failed nonempty repair never substitutes an empty import; exact replay retains every message", async () => {
  await withStore(async (db) => {
    const attempts: number[] = [];
    let loseReceipt = true;
    const importer: Parameters<typeof repairPersonalConversation>[1] = async (messages) => {
      attempts.push(messages.length);
      for (const message of messages) {
        await db.query("INSERT INTO messages VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING", [
          message.sourceId,
          message.role,
          message.text,
          message.timestamp ?? null,
        ]);
        if (loseReceipt) {
          loseReceipt = false;
          return null;
        }
      }
      await db.query("INSERT INTO conversations VALUES ('owned-room') ON CONFLICT DO NOTHING");
      return { complete: true };
    };
    expect(await repairPersonalConversation(history, importer)).toBe(false);
    expect(attempts).toEqual([2]);
    expect((await db.query("SELECT * FROM messages")).rows).toHaveLength(1);
    expect(await repairPersonalConversation(history, importer)).toBe(true);
    expect(attempts).toEqual([2, 2]);
    expect((await db.query("SELECT * FROM messages ORDER BY created_at")).rows).toEqual([
      { id: "first", role: "user", content: history[0].content, created_at: 0 },
      { id: "second", role: "assistant", content: history[1].content, created_at: 1 },
    ]);
  });
});

test("missing source identity refuses repair before any partial or empty write", async () => {
  await withStore(async (db) => {
    let attempts = 0;
    const repaired = await repairPersonalConversation(
      [...history, { role: "user", content: "No stable source identity" }],
      async () => {
        attempts++;
        await db.query("INSERT INTO conversations VALUES ('owned-room')");
        return { complete: true };
      },
    );
    expect(repaired).toBe(false);
    expect(attempts).toBe(0);
    expect((await db.query("SELECT * FROM conversations")).rows).toEqual([]);
  });
});

test("a genuinely empty new source still creates the canonical conversation", async () => {
  await withStore(async (db) => {
    const attempts: number[] = [];
    expect(
      await repairPersonalConversation([], async (messages) => {
        attempts.push(messages.length);
        await db.query("INSERT INTO conversations VALUES ('owned-room')");
        return { complete: true };
      }),
    ).toBe(true);
    expect(attempts).toEqual([0]);
    expect((await db.query("SELECT * FROM conversations")).rows).toEqual([{ id: "owned-room" }]);
  });
});
