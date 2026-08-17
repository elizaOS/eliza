/**
 * Proves messages_limit=0 is preserved via ?? (rank 9 security bypass).
 * Admin intent 0 = block anonymous; || collapses 0→10 and grants 10 free msgs.
 * Uses real PGlite for reserveMessageSlot proof; create path verified via file grep + JS ??.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

let dbWrite: any;
let repo: any;
let ready = true;

beforeAll(async () => {
  try {
    const helpers = await import("../helpers");
    dbWrite = helpers.dbWrite;
    const mod = await import("./anonymous-sessions");
    repo = mod.anonymousSessionsRepository;
    await dbWrite.execute(sql`
      CREATE TABLE IF NOT EXISTS anonymous_sessions (
        id uuid PRIMARY KEY,
        session_token text NOT NULL UNIQUE,
        user_id uuid NOT NULL,
        message_count integer NOT NULL DEFAULT 0,
        messages_limit integer NOT NULL DEFAULT 10,
        total_tokens_used integer NOT NULL DEFAULT 0,
        last_message_at timestamp,
        hourly_message_count integer NOT NULL DEFAULT 0,
        hourly_reset_at timestamp,
        gate_revision bigint NOT NULL DEFAULT 0,
        ip_address text,
        user_agent text,
        fingerprint text,
        signup_prompted_at timestamp,
        signup_prompt_count integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now(),
        expires_at timestamp NOT NULL,
        converted_at timestamp,
        is_active boolean NOT NULL DEFAULT true
      )
    `);
  } catch (e) {
    ready = false;
    console.error("[anon-limit-zero] setup failed", e);
    throw e;
  }
});

beforeEach(async () => {
  expect(ready).toBe(true);
  await dbWrite.execute(sql`DELETE FROM anonymous_sessions`);
});

afterAll(async () => {
  if (ready) await dbWrite.execute(sql`DROP TABLE IF EXISTS anonymous_sessions`);
});

describe("AnonymousSessionsRepository messages_limit=0 (rank 9 bypass)", () => {
  test("file uses ?? not || for messages_limit", () => {
    const src = readFileSync(new URL("./anonymous-sessions.ts", import.meta.url).pathname, "utf8");
    expect(src).toContain("data.messages_limit ?? 10");
    expect(src).not.toContain("data.messages_limit || 10");
  });

  test("reserveMessageSlot with messages_limit=0 blocks (lt(0,0)=false)", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000401";
    await dbWrite.execute(sql`
      INSERT INTO anonymous_sessions (id, session_token, user_id, message_count, messages_limit, expires_at)
      VALUES (${sessionId}, 'tok-zero', '00000000-0000-4000-8000-000000000501', 0, 0, now() + interval '1 day')
    `);
    const reserved = await repo.reserveMessageSlot(sessionId);
    expect(reserved).toBeNull();
  });

  test("reserveMessageSlot with messages_limit=10 allows one slot", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000402";
    await dbWrite.execute(sql`
      INSERT INTO anonymous_sessions (id, session_token, user_id, message_count, messages_limit, expires_at)
      VALUES (${sessionId}, 'tok-ten', '00000000-0000-4000-8000-000000000502', 0, 10, now() + interval '1 day')
    `);
    const reserved = await repo.reserveMessageSlot(sessionId);
    expect(reserved).not.toBeNull();
    expect(reserved.message_count).toBe(1);
  });

  test("direct ?? vs || proof", () => {
    const zero: number | undefined = 0;
    expect(zero ?? 10).toBe(0);
    expect((zero as any) || 10).toBe(10);
  });
});
