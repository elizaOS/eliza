// Exercises cloud DB anonymous sessions behavior with deterministic repository fixtures.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.ANON_HOURLY_LIMIT ||= "10";

let dbWrite: typeof import("../helpers").dbWrite;
let closeDatabaseConnectionsForTests: typeof import("../client").closeDatabaseConnectionsForTests;
let anonymousSessionsRepository: typeof import("./anonymous-sessions").anonymousSessionsRepository;
let pgliteReady = true;

beforeAll(async () => {
  try {
    ({ dbWrite } = await import("../helpers"));
    ({ closeDatabaseConnectionsForTests } = await import("../client"));
    ({ anonymousSessionsRepository } = await import("./anonymous-sessions"));

    await dbWrite.execute(sql`
      CREATE TABLE IF NOT EXISTS anonymous_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
  } catch {
    pgliteReady = false;
  }
});

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.execute(sql`DELETE FROM anonymous_sessions`);
});

afterAll(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.execute(sql`DROP TABLE IF EXISTS anonymous_sessions`);
  await closeDatabaseConnectionsForTests();
});

afterEach(() => {
  setSystemTime();
});

describe("AnonymousSessionsRepository free-message reservations", () => {
  test("preserves a zero message limit and refuses a reservation", async () => {
    const session = await anonymousSessionsRepository.create({
      session_token: "anon-token-zero-limit",
      user_id: "00000000-0000-4000-8000-000000000200",
      messages_limit: 0,
      expires_at: new Date("2099-01-01T00:00:00.000Z"),
    });

    expect(session.messages_limit).toBe(0);
    await expect(anonymousSessionsRepository.reserveMessageSlot(session.id)).resolves.toBeNull();
  });

  test("reserves a message slot atomically at the configured limit", async () => {
    expect(pgliteReady).toBe(true);

    const sessionId = "00000000-0000-4000-8000-000000000101";
    await dbWrite.execute(sql`
      INSERT INTO anonymous_sessions (
        id,
        session_token,
        user_id,
        message_count,
        messages_limit,
        expires_at
      )
      VALUES (
        ${sessionId},
        'anon-token-1',
        '00000000-0000-4000-8000-000000000201',
        9,
        10,
        now() + interval '1 day'
      )
    `);

    const results = await Promise.all([
      anonymousSessionsRepository.reserveMessageSlot(sessionId),
      anonymousSessionsRepository.reserveMessageSlot(sessionId),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);

    const stored = await anonymousSessionsRepository.getByToken("anon-token-1");
    expect(stored?.message_count).toBe(10);
  });

  test("refunds a reserved slot without underflowing the counter", async () => {
    expect(pgliteReady).toBe(true);

    const sessionId = "00000000-0000-4000-8000-000000000102";
    await dbWrite.execute(sql`
      INSERT INTO anonymous_sessions (
        id,
        session_token,
        user_id,
        message_count,
        messages_limit,
        expires_at
      )
      VALUES (
        ${sessionId},
        'anon-token-2',
        '00000000-0000-4000-8000-000000000202',
        1,
        10,
        now() + interval '1 day'
      )
    `);

    await anonymousSessionsRepository.refundMessageSlot(sessionId);
    await anonymousSessionsRepository.refundMessageSlot(sessionId);

    const stored = await anonymousSessionsRepository.getByToken("anon-token-2");
    expect(stored?.message_count).toBe(0);
  });

  test("refuses at the hourly boundary and resets one millisecond later", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000103";
    const hourlyLimit = Number.parseInt(process.env.ANON_HOURLY_LIMIT ?? "10", 10);
    const windowStartedAt = new Date("2027-01-15T12:00:00.000Z");
    await dbWrite.execute(sql`
      INSERT INTO anonymous_sessions (
        id,
        session_token,
        user_id,
        hourly_message_count,
        hourly_reset_at,
        expires_at
      )
      VALUES (
        ${sessionId},
        'anon-token-hourly-active',
        '00000000-0000-4000-8000-000000000203',
        ${hourlyLimit},
        ${windowStartedAt},
        '2099-01-01T00:00:00.000Z'
      )
    `);

    setSystemTime(windowStartedAt.getTime() + 60 * 60 * 1_000);
    await expect(anonymousSessionsRepository.incrementHourlyCount(sessionId)).resolves.toEqual({
      allowed: false,
      remaining: 0,
      retryAfter: 1,
    });

    const atBoundary = await anonymousSessionsRepository.getByToken("anon-token-hourly-active");
    expect(atBoundary?.hourly_reset_at?.getTime()).toBe(windowStartedAt.getTime());

    setSystemTime(windowStartedAt.getTime() + 60 * 60 * 1_000 + 1);
    await expect(anonymousSessionsRepository.incrementHourlyCount(sessionId)).resolves.toEqual({
      allowed: true,
      remaining: hourlyLimit - 1,
    });

    const rolledOver = await anonymousSessionsRepository.getByToken("anon-token-hourly-active");
    expect(rolledOver?.hourly_message_count).toBe(1);
    expect(rolledOver?.hourly_reset_at?.getTime()).toBe(
      windowStartedAt.getTime() + 60 * 60 * 1_000 + 1,
    );
  });
});
