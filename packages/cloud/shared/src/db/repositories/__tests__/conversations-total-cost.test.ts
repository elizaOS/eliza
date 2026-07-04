/**
 * Fail-closed NUMERIC boundary for the conversation `total_cost` accumulator
 * (#13416, cloud-shared DB-repository fallback-slop sweep).
 *
 * Before this slice `addMessageWithSequence` advanced the accumulator with an
 * unguarded JS-side read-modify-write:
 *
 *   total_cost = String(Number(conversation.total_cost) + Number(data.cost || 0))
 *
 * The value is written straight back into the notNull NUMERIC(10,2)
 * `total_cost` column, and there is NO DB check-constraint backstop. Two
 * corruption vectors:
 *
 *   - a corrupt stored `total_cost` → `Number("NaN")` = NaN → `String(NaN + c)`
 *     = "NaN" is written back, PERMANENTLY poisoning the accumulator (every
 *     later add cascades NaN). Postgres NUMERIC really can hold the special
 *     value 'NaN'::numeric, so this is not hypothetical — the first test below
 *     seeds exactly that.
 *   - a present-but-non-finite caller `cost` → same NaN/Infinity poison.
 *
 * The write "succeeds" silently (the driver does not reject `"NaN"`), so the
 * corruption is invisible until a downstream reader trips over it.
 *
 * The parser tests pin the boundary in isolation; the PGlite-backed tests prove
 * the guard fires INSIDE the transaction — rolling back both the message insert
 * and the stats update atomically — instead of committing a poisoned total,
 * while a legitimate $0 / well-formed cost still accumulates. DB cases
 * self-skip if PGlite is unavailable.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { parseConversationCostNumber } from "../conversations-numeric";

describe("parseConversationCostNumber", () => {
  test("parses a well-formed NUMERIC string", () => {
    expect(parseConversationCostNumber("1.50", "total_cost")).toBe(1.5);
    expect(parseConversationCostNumber("100.00", "total_cost")).toBe(100);
  });

  test("parses a numeric literal", () => {
    expect(parseConversationCostNumber(0, "message cost")).toBe(0);
    expect(parseConversationCostNumber(0.42, "message cost")).toBe(0.42);
  });

  test("allows an explicit domain zero", () => {
    expect(parseConversationCostNumber("0", "total_cost")).toBe(0);
    expect(parseConversationCostNumber("0.00", "total_cost")).toBe(0);
  });

  test("throws on null / undefined instead of fabricating 0", () => {
    expect(() => parseConversationCostNumber(null, "total_cost")).toThrow(/total_cost/);
    expect(() => parseConversationCostNumber(undefined, "message cost")).toThrow(/message cost/);
  });

  test("throws on empty / whitespace-only instead of fabricating 0", () => {
    expect(() => parseConversationCostNumber("", "total_cost")).toThrow(/empty or missing/);
    expect(() => parseConversationCostNumber("   ", "message cost")).toThrow(/empty or missing/);
  });

  test("REGRESSION: a corrupt / non-finite value throws instead of becoming NaN", () => {
    // The exact class the accumulator used to swallow: Number("NaN")/Number("corrupt")
    // are NaN, and `String(NaN + c)` = "NaN" was written straight back.
    expect(Number("NaN")).toBeNaN();
    expect(() => parseConversationCostNumber("NaN", "total_cost")).toThrow(/not a finite number/);
    expect(() => parseConversationCostNumber("corrupt", "total_cost")).toThrow(
      /not a finite number/,
    );
    expect(() => parseConversationCostNumber("1.2.3", "message cost")).toThrow(
      /not a finite number/,
    );
    expect(() => parseConversationCostNumber("Infinity", "message cost")).toThrow(
      /not a finite number/,
    );
    expect(() => parseConversationCostNumber(Number.POSITIVE_INFINITY, "message cost")).toThrow(
      /not a finite number/,
    );
  });
});

const PGLITE_TIMEOUT = 60000;

const ORG_ID = "00000000-0000-0000-0000-0000000000d1";
const USER_ID = "00000000-0000-0000-0000-0000000000d2";
const CONV_HEALTHY = "00000000-0000-0000-0000-0000000000e1";
const CONV_CORRUPT = "00000000-0000-0000-0000-0000000000e2";
const CONV_BADCOST = "00000000-0000-0000-0000-0000000000e3";

let dbWrite: typeof import("../../client").dbWrite;
let closeDb: typeof import("../../client").closeDatabaseConnectionsForTests | undefined;
let conversationsRepository: typeof import("../conversations").conversationsRepository;
let pgliteReady = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../client"));
    ({ conversationsRepository } = await import("../conversations"));

    // Minimal schema for the columns addMessageWithSequence touches. FKs are
    // omitted (single-repository seam under test). One statement per execute()
    // (drizzle uses the extended protocol).
    const ddl = [
      `CREATE TABLE IF NOT EXISTS conversations (
        id uuid PRIMARY KEY,
        organization_id uuid,
        user_id uuid NOT NULL,
        title text NOT NULL DEFAULT 'c',
        model text NOT NULL DEFAULT 'm',
        settings jsonb NOT NULL DEFAULT '{}',
        status text NOT NULL DEFAULT 'active',
        message_count integer NOT NULL DEFAULT 0,
        total_cost numeric(10,2) NOT NULL DEFAULT '0.00',
        last_message_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        deleted_at timestamp
      )`,
      `CREATE TABLE IF NOT EXISTS conversation_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id uuid NOT NULL,
        role text NOT NULL,
        content text NOT NULL,
        content_storage text NOT NULL DEFAULT 'inline',
        content_key text,
        content_ciphertext text,
        content_nonce text,
        content_auth_tag text,
        content_kms_key_id text,
        content_kms_key_version integer,
        sequence_number integer NOT NULL,
        model text,
        tokens integer,
        cost numeric(10,2) DEFAULT '0.00',
        usage_record_id uuid,
        api_request jsonb,
        api_request_storage text NOT NULL DEFAULT 'inline',
        api_request_key text,
        api_response jsonb,
        api_response_storage text NOT NULL DEFAULT 'inline',
        api_response_key text,
        processing_time integer,
        created_at timestamp NOT NULL DEFAULT now()
      )`,
    ];
    for (const stmt of ddl) {
      await dbWrite.execute(stmt);
    }
  } catch (error) {
    pgliteReady = false;
    console.warn("[conversations-total-cost] PGlite unavailable, skipping DB cases:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

async function seedConversation(id: string, totalCostLiteral: string): Promise<void> {
  await dbWrite.execute(
    `INSERT INTO conversations (id, organization_id, user_id, total_cost, message_count)
     VALUES ('${id}', '${ORG_ID}', '${USER_ID}', '${totalCostLiteral}'::numeric, 0);`,
  );
}

async function messageCount(conversationId: string): Promise<number> {
  const r = await dbWrite.execute(
    `SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id = '${conversationId}';`,
  );
  return (r.rows[0] as { n: number }).n;
}

async function readStats(
  conversationId: string,
): Promise<{ total_cost: string; message_count: number }> {
  const r = await dbWrite.execute(
    `SELECT total_cost, message_count FROM conversations WHERE id = '${conversationId}';`,
  );
  return r.rows[0] as { total_cost: string; message_count: number };
}

describe("addMessageWithSequence total_cost accumulator", () => {
  test(
    "healthy row: accumulates a well-formed cost and bumps message_count",
    async () => {
      if (!pgliteReady) return;
      await seedConversation(CONV_HEALTHY, "1.25");

      await conversationsRepository.addMessageWithSequence(CONV_HEALTHY, {
        role: "assistant",
        content: "hello",
        cost: "0.75",
      });

      const stats = await readStats(CONV_HEALTHY);
      expect(Number(stats.total_cost)).toBeCloseTo(2.0, 2);
      expect(stats.message_count).toBe(1);
      expect(await messageCount(CONV_HEALTHY)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "missing per-message cost is a legitimate $0 contribution (preserves `cost || 0` semantics)",
    async () => {
      if (!pgliteReady) return;
      // reuse the healthy conversation: total is 2.00, add a costless message.
      await conversationsRepository.addMessageWithSequence(CONV_HEALTHY, {
        role: "user",
        content: "no cost field",
        // cost omitted → null default → treated as 0, not a throw.
      });

      const stats = await readStats(CONV_HEALTHY);
      expect(Number(stats.total_cost)).toBeCloseTo(2.0, 2);
      expect(stats.message_count).toBe(2);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "corrupt stored total_cost ('NaN'::numeric) FAILS CLOSED and rolls back — no message, no poison",
    async () => {
      if (!pgliteReady) return;
      await seedConversation(CONV_CORRUPT, "NaN"); // Postgres NUMERIC can hold NaN.
      // Sanity: the stored value really reads back as the string "NaN".
      const before = await readStats(CONV_CORRUPT);
      expect(before.total_cost).toBe("NaN");

      // Before the fix: Number("NaN") = NaN → String(NaN + 0.5) = "NaN" written
      // back, committing a poisoned total AND the message. Now it must throw at
      // the read boundary, rolling back the whole transaction.
      await expect(
        conversationsRepository.addMessageWithSequence(CONV_CORRUPT, {
          role: "assistant",
          content: "should not persist",
          cost: "0.50",
        }),
      ).rejects.toThrow(/total_cost/);

      // Atomic rollback: no message inserted, stats untouched (still NaN, not
      // silently re-poisoned or advanced).
      expect(await messageCount(CONV_CORRUPT)).toBe(0);
      const after = await readStats(CONV_CORRUPT);
      expect(after.message_count).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "non-finite per-message cost FAILS CLOSED and rolls back — no message, healthy total untouched",
    async () => {
      if (!pgliteReady) return;
      await seedConversation(CONV_BADCOST, "5.00");

      // A caller cost of "NaN" (or "Infinity") would have produced
      // String(5 + NaN) = "NaN", poisoning a previously-healthy accumulator.
      await expect(
        conversationsRepository.addMessageWithSequence(CONV_BADCOST, {
          role: "assistant",
          content: "should not persist",
          cost: "NaN",
        }),
      ).rejects.toThrow(/message cost/);

      expect(await messageCount(CONV_BADCOST)).toBe(0);
      const after = await readStats(CONV_BADCOST);
      // Healthy total preserved exactly, not clobbered to "NaN".
      expect(Number(after.total_cost)).toBeCloseTo(5.0, 2);
      expect(after.message_count).toBe(0);
    },
    PGLITE_TIMEOUT,
  );
});
