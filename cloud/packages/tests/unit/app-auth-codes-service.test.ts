/**
 * App auth codes service — sociable unit test.
 *
 * The repository (Drizzle/Postgres) is the only mocked boundary; everything
 * else is the real service code. We verify:
 *   - issued codes carry the `eac_` prefix, 64-hex tail, and TTL metadata
 *   - the persisted column holds the SHA-256 hash, not the plaintext
 *   - consume() returns the original `{appId, userId, ...}` on a fresh code
 *     and null on replay (single-use)
 *   - consume() short-circuits before hitting the DB on non-matching prefixes
 *   - looksLikeAppAuthCode is a strict, case-sensitive prefix guard
 *   - expired rows are filtered even before the cleanup cron runs
 *   - independent codes don't collide across many issues (entropy proof)
 *   - the persisted code_hash is case-sensitive at consume time
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AppAuthCode,
  NewAppAuthCode,
} from "@/db/repositories/app-auth-codes";
import { appAuthCodesRepository } from "@/db/repositories/app-auth-codes";
import {
  APP_AUTH_CODE_TTL_SECONDS,
  consumeAppAuthCode,
  issueAppAuthCode,
  looksLikeAppAuthCode,
} from "@/lib/services/app-auth-codes";

const originalCreate = appAuthCodesRepository.create.bind(
  appAuthCodesRepository,
);
const originalConsume = appAuthCodesRepository.consume.bind(
  appAuthCodesRepository,
);

const APP_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("App auth codes service", () => {
  let store: Map<string, AppAuthCode>;
  let lastCreated: NewAppAuthCode | null;

  beforeEach(() => {
    store = new Map();
    lastCreated = null;

    appAuthCodesRepository.create = (async (record: NewAppAuthCode) => {
      lastCreated = record;
      const row: AppAuthCode = {
        ...record,
        issued_at: record.issued_at ?? new Date(),
      };
      store.set(record.code_hash, row);
      return row;
    }) as typeof appAuthCodesRepository.create;

    appAuthCodesRepository.consume = (async (codeHash: string) => {
      const row = store.get(codeHash);
      if (!row || row.expires_at.getTime() <= Date.now()) return undefined;
      store.delete(codeHash);
      return row;
    }) as typeof appAuthCodesRepository.consume;
  });

  afterEach(() => {
    appAuthCodesRepository.create = originalCreate;
    appAuthCodesRepository.consume = originalConsume;
  });

  test("issued codes have the eac_ prefix, a 64-hex random tail, and TTL metadata", async () => {
    const before = Date.now();
    const { code, expiresAt, expiresIn } = await issueAppAuthCode({
      appId: APP_ID,
      userId: USER_ID,
    });
    const after = Date.now();

    // Two crypto.randomUUID() concatenations stripped of dashes = 64 hex chars.
    expect(code).toMatch(/^eac_[0-9a-f]{64}$/);
    expect(expiresIn).toBe(APP_AUTH_CODE_TTL_SECONDS);

    const expiresAtMs = Date.parse(expiresAt);
    expect(Number.isNaN(expiresAtMs)).toBe(false);
    expect(expiresAtMs).toBeGreaterThanOrEqual(
      before + APP_AUTH_CODE_TTL_SECONDS * 1000,
    );
    expect(expiresAtMs).toBeLessThanOrEqual(
      after + APP_AUTH_CODE_TTL_SECONDS * 1000,
    );
  });

  test("persists SHA-256(code) as code_hash, never the plaintext", async () => {
    const { code } = await issueAppAuthCode({ appId: APP_ID, userId: USER_ID });

    const expectedHash = await sha256Hex(code);
    if (!lastCreated) throw new Error("expected create() to have been called");
    const created = lastCreated;
    expect(created.code_hash).toBe(expectedHash);
    expect(created.code_hash).toHaveLength(64);
    expect(created.code_hash).not.toBe(code);
    expect(created.code_hash).not.toContain(code);
    expect(created.app_id).toBe(APP_ID);
    expect(created.user_id).toBe(USER_ID);
    // The service always supplies issued_at, even though the insert type marks
    // it optional (DB default). Assert so the TTL arithmetic stays well-typed.
    if (!created.issued_at)
      throw new Error("expected service to set issued_at");
    expect(created.expires_at.getTime() - created.issued_at.getTime()).toBe(
      APP_AUTH_CODE_TTL_SECONDS * 1000,
    );
  });

  test("consume returns the original record once, then null on replay", async () => {
    const before = Date.now();
    const { code } = await issueAppAuthCode({ appId: APP_ID, userId: USER_ID });
    const after = Date.now();

    const first = await consumeAppAuthCode(code);
    expect(first?.appId).toBe(APP_ID);
    expect(first?.userId).toBe(USER_ID);
    expect(first?.issuedAt).toBeGreaterThanOrEqual(before);
    expect(first?.issuedAt).toBeLessThanOrEqual(after);
    expect(first?.expiresAt).toBe(
      first!.issuedAt + APP_AUTH_CODE_TTL_SECONDS * 1000,
    );

    const second = await consumeAppAuthCode(code);
    expect(second).toBeNull();
  });

  test("consume rejects strings without the eac_ prefix without hitting the DB", async () => {
    let consumed = 0;
    appAuthCodesRepository.consume = (async () => {
      consumed++;
      return undefined;
    }) as typeof appAuthCodesRepository.consume;

    expect(await consumeAppAuthCode("not-a-code")).toBeNull();
    expect(await consumeAppAuthCode("eliza_test")).toBeNull();
    expect(await consumeAppAuthCode("")).toBeNull();
    expect(consumed).toBe(0);
  });

  test("looksLikeAppAuthCode is a strict prefix guard", () => {
    expect(looksLikeAppAuthCode("eac_abcdef")).toBe(true);
    expect(looksLikeAppAuthCode("EAC_abcdef")).toBe(false);
    expect(looksLikeAppAuthCode("eliza_abcdef")).toBe(false);
    expect(looksLikeAppAuthCode(null)).toBe(false);
    expect(looksLikeAppAuthCode(undefined)).toBe(false);
    expect(looksLikeAppAuthCode("")).toBe(false);
  });

  test("expired rows are not returned even before the cleanup cron runs", async () => {
    const { code } = await issueAppAuthCode({ appId: APP_ID, userId: USER_ID });

    const codeHash = [...store.keys()][0]!;
    const row = store.get(codeHash)!;
    store.set(codeHash, { ...row, expires_at: new Date(Date.now() - 1_000) });

    expect(await consumeAppAuthCode(code)).toBeNull();
  });

  test("issued codes are unique across many issues and consume independently", async () => {
    const ISSUE_COUNT = 50;
    const issued = await Promise.all(
      Array.from({ length: ISSUE_COUNT }, () =>
        issueAppAuthCode({ appId: APP_ID, userId: USER_ID }),
      ),
    );
    const codes = issued.map((r) => r.code);
    expect(new Set(codes).size).toBe(ISSUE_COUNT);

    // Consuming the first one must not invalidate the rest.
    const firstConsumed = await consumeAppAuthCode(codes[0]!);
    expect(firstConsumed?.userId).toBe(USER_ID);

    const lastConsumed = await consumeAppAuthCode(codes[ISSUE_COUNT - 1]!);
    expect(lastConsumed?.userId).toBe(USER_ID);
  });

  test("consume is case-sensitive on the SHA-256 hash lookup", async () => {
    const { code } = await issueAppAuthCode({ appId: APP_ID, userId: USER_ID });

    // Same plaintext but uppercase: not a valid hex of the same bytes, so the
    // store lookup must miss and consume must return null without touching the
    // real row. We assert by consuming with an uppercased code (whose SHA-256
    // differs from the lowercased original) and confirming the original still
    // redeems afterwards.
    const upper = `eac_${code.slice(4).toUpperCase()}`;
    expect(upper).not.toBe(code);
    expect(await consumeAppAuthCode(upper)).toBeNull();

    const consumed = await consumeAppAuthCode(code);
    expect(consumed?.userId).toBe(USER_ID);
  });
});
