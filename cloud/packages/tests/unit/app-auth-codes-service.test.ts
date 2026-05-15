/**
 * App auth codes service — sociable unit test.
 *
 * The repository (Drizzle/Postgres) is the only mocked boundary; everything
 * else is the real service code. We verify:
 *   - codes carry the `eac_` prefix and are sufficiently long
 *   - the persisted column holds the SHA-256 hash, not the plaintext
 *   - consume() returns the original `{appId, userId, ...}` on a fresh code
 *   - consume() is single-use (second call returns null)
 *   - consume() rejects values whose prefix doesn't match
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AppAuthCode } from "@/db/repositories/app-auth-codes";
import { appAuthCodesRepository } from "@/db/repositories/app-auth-codes";
import {
  APP_AUTH_CODE_TTL_SECONDS,
  consumeAppAuthCode,
  issueAppAuthCode,
  looksLikeAppAuthCode,
} from "@/lib/services/app-auth-codes";

interface CreateInput {
  code_hash: string;
  app_id: string;
  user_id: string;
  issued_at: Date;
  expires_at: Date;
}

const originalCreate = appAuthCodesRepository.create.bind(appAuthCodesRepository);
const originalConsume = appAuthCodesRepository.consume.bind(appAuthCodesRepository);
const originalFindActive = appAuthCodesRepository.findActiveByHash.bind(appAuthCodesRepository);

const APP_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

describe("App auth codes service", () => {
  let store: Map<string, AppAuthCode>;
  let lastCreated: CreateInput | null;

  beforeEach(() => {
    store = new Map();
    lastCreated = null;

    appAuthCodesRepository.create = (async (record: CreateInput) => {
      lastCreated = record;
      const row: AppAuthCode = { ...record };
      store.set(record.code_hash, row);
      return row;
    }) as typeof appAuthCodesRepository.create;

    appAuthCodesRepository.consume = (async (codeHash: string) => {
      const row = store.get(codeHash);
      if (!row || row.expires_at.getTime() <= Date.now()) return undefined;
      store.delete(codeHash);
      return row;
    }) as typeof appAuthCodesRepository.consume;

    appAuthCodesRepository.findActiveByHash = (async (codeHash: string) => {
      const row = store.get(codeHash);
      if (!row || row.expires_at.getTime() <= Date.now()) return undefined;
      return row;
    }) as typeof appAuthCodesRepository.findActiveByHash;
  });

  afterEach(() => {
    appAuthCodesRepository.create = originalCreate;
    appAuthCodesRepository.consume = originalConsume;
    appAuthCodesRepository.findActiveByHash = originalFindActive;
  });

  test("issued codes carry the eac_ prefix and a high-entropy random tail", async () => {
    const { code, expiresIn } = await issueAppAuthCode({
      appId: APP_ID,
      userId: USER_ID,
    });

    expect(code.startsWith("eac_")).toBe(true);
    expect(code.length).toBeGreaterThan("eac_".length + 32);
    expect(expiresIn).toBe(APP_AUTH_CODE_TTL_SECONDS);
  });

  test("persists the SHA-256 hash of the code, never the plaintext", async () => {
    const { code } = await issueAppAuthCode({ appId: APP_ID, userId: USER_ID });

    expect(lastCreated).not.toBeNull();
    expect(lastCreated?.code_hash.length).toBe(64); // 32 bytes × 2 hex chars
    expect(lastCreated?.code_hash).not.toBe(code);
    expect(lastCreated?.code_hash).not.toContain(code);
    expect(lastCreated?.app_id).toBe(APP_ID);
    expect(lastCreated?.user_id).toBe(USER_ID);
  });

  test("consume returns the original record once, then null on replay", async () => {
    const { code } = await issueAppAuthCode({ appId: APP_ID, userId: USER_ID });

    const first = await consumeAppAuthCode(code);
    expect(first?.appId).toBe(APP_ID);
    expect(first?.userId).toBe(USER_ID);
    expect(first?.expiresAt).toBeGreaterThan(Date.now());

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

  test("two issued codes are independent — consuming one does not affect the other", async () => {
    const a = await issueAppAuthCode({ appId: APP_ID, userId: USER_ID });
    const b = await issueAppAuthCode({ appId: APP_ID, userId: USER_ID });

    expect(a.code).not.toBe(b.code);

    const consumedA = await consumeAppAuthCode(a.code);
    expect(consumedA?.userId).toBe(USER_ID);

    const consumedB = await consumeAppAuthCode(b.code);
    expect(consumedB?.userId).toBe(USER_ID);
  });
});
