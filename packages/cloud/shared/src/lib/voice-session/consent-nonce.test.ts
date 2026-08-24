/**
 * Voice-session consent nonce (SEC-21). Consent is a server-enforced mint
 * precondition, so the properties that matter are refusals: a nonce is
 * single-use, scoped to its issuing user, and an unconfigured store refuses
 * rather than fabricating consent. Runs against the repository's own in-memory
 * Redis (MOCK_REDIS=1) so the atomic getdel path is exercised for real, plus a
 * no-store lane that asserts the fail-closed behaviour. Env is saved and
 * restored per test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetConsentNonceClientForTests,
  CONSENT_NONCE_TTL_SECONDS,
  consumeConsentNonce,
  isConsentStoreConfigured,
  issueConsentNonce,
} from "./consent-nonce";

const REDIS_KEYS = [
  "MOCK_REDIS",
  "REDIS_URL",
  "DIRECT_REDIS_BACKEND",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(REDIS_KEYS.map((k) => [k, process.env[k]]));
  for (const key of REDIS_KEYS) delete process.env[key];
  __resetConsentNonceClientForTests();
});

afterEach(() => {
  for (const key of REDIS_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  __resetConsentNonceClientForTests();
});

/** Turn on the repository's in-memory Redis for this test. */
function withStore(): void {
  process.env.MOCK_REDIS = "1";
  __resetConsentNonceClientForTests();
}

describe("configuration", () => {
  test("TTL is short-lived and positive", () => {
    expect(Number.isInteger(CONSENT_NONCE_TTL_SECONDS)).toBe(true);
    expect(CONSENT_NONCE_TTL_SECONDS).toBeGreaterThan(0);
    expect(CONSENT_NONCE_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
  });

  test("reports the store as unconfigured with no backend env", () => {
    expect(isConsentStoreConfigured()).toBe(false);
  });

  test("reports the store as configured under the mock backend", () => {
    withStore();
    expect(isConsentStoreConfigured()).toBe(true);
  });
});

describe("fail closed with no store", () => {
  test("issuing yields null rather than a usable nonce", async () => {
    expect(await issueConsentNonce("user-a")).toBeNull();
  });

  test("consuming refuses any nonce", async () => {
    for (const nonce of ["any", crypto.randomUUID(), "00000000-0000-0000-0000-000000000000"]) {
      expect(await consumeConsentNonce("user-a", nonce)).toBe(false);
    }
  });

  test("a nonce issued while configured is refused once the store is gone", async () => {
    withStore();
    const issued = await issueConsentNonce("user-a");
    expect(issued).not.toBeNull();

    delete process.env.MOCK_REDIS;
    __resetConsentNonceClientForTests();
    expect(await consumeConsentNonce("user-a", (issued as { nonce: string }).nonce)).toBe(false);
  });
});

describe("issueConsentNonce — input validation", () => {
  test("rejects a missing or blank userId before touching the store", async () => {
    withStore();
    for (const userId of ["", "   ", "\t\n"]) {
      expect(issueConsentNonce(userId)).rejects.toThrow();
    }
  });

  test("rejects a non-string userId", async () => {
    withStore();
    for (const userId of [null, undefined, 42, {}, []]) {
      expect(issueConsentNonce(userId as unknown as string)).rejects.toThrow();
    }
  });
});

describe("issueConsentNonce — issued shape", () => {
  test("returns a UUID nonce and a future expiry", async () => {
    withStore();
    const issued = await issueConsentNonce("user-a");
    expect(issued).not.toBeNull();
    const { nonce, expiresAt } = issued as { nonce: string; expiresAt: string };
    expect(nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const ms = Date.parse(expiresAt);
    expect(Number.isNaN(ms)).toBe(false);
    expect(ms).toBeGreaterThan(Date.now());
    expect(ms).toBeLessThanOrEqual(Date.now() + CONSENT_NONCE_TTL_SECONDS * 1000 + 5000);
  });

  test("never reissues the same nonce", async () => {
    withStore();
    const nonces = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const issued = await issueConsentNonce("user-a");
      nonces.add((issued as { nonce: string }).nonce);
    }
    expect(nonces.size).toBe(25);
  });
});

describe("consumeConsentNonce — input validation", () => {
  test("refuses blank or non-string arguments without throwing", async () => {
    withStore();
    const bad = ["", "   ", null, undefined, 42, {}] as unknown as string[];
    for (const value of bad) {
      expect(await consumeConsentNonce(value, "n")).toBe(false);
      expect(await consumeConsentNonce("user-a", value)).toBe(false);
    }
  });
});

describe("consumeConsentNonce — single use", () => {
  test("consumes a freshly issued nonce exactly once", async () => {
    withStore();
    const issued = await issueConsentNonce("user-a");
    const { nonce } = issued as { nonce: string };
    expect(await consumeConsentNonce("user-a", nonce)).toBe(true);
    expect(await consumeConsentNonce("user-a", nonce)).toBe(false);
  });

  test("refuses a replay however many times it is retried", async () => {
    withStore();
    const { nonce } = (await issueConsentNonce("user-a")) as { nonce: string };
    expect(await consumeConsentNonce("user-a", nonce)).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      expect(await consumeConsentNonce("user-a", nonce)).toBe(false);
    }
  });

  test("only one of many concurrent consumers wins", async () => {
    withStore();
    const { nonce } = (await issueConsentNonce("user-a")) as { nonce: string };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => consumeConsentNonce("user-a", nonce)),
    );
    expect(results.filter(Boolean).length).toBe(1);
  });

  test("refuses a nonce that was never issued", async () => {
    withStore();
    expect(await consumeConsentNonce("user-a", crypto.randomUUID())).toBe(false);
  });

  test("consuming one nonce does not invalidate another", async () => {
    withStore();
    const first = (await issueConsentNonce("user-a")) as { nonce: string };
    const second = (await issueConsentNonce("user-a")) as { nonce: string };
    expect(await consumeConsentNonce("user-a", first.nonce)).toBe(true);
    expect(await consumeConsentNonce("user-a", second.nonce)).toBe(true);
  });
});

describe("consumeConsentNonce — user scoping", () => {
  test("a nonce issued to one user cannot mint for another", async () => {
    withStore();
    const { nonce } = (await issueConsentNonce("user-a")) as { nonce: string };
    expect(await consumeConsentNonce("user-b", nonce)).toBe(false);
    // Still valid for its rightful owner — the failed attempt consumed nothing.
    expect(await consumeConsentNonce("user-a", nonce)).toBe(true);
  });

  test("scoping is exact, not prefix-based", async () => {
    withStore();
    const { nonce } = (await issueConsentNonce("user")) as { nonce: string };
    for (const impostor of ["user-x", "use", "User", " user", "user "]) {
      expect(await consumeConsentNonce(impostor, nonce)).toBe(false);
    }
    expect(await consumeConsentNonce("user", nonce)).toBe(true);
  });

  test("two users' nonces are independent", async () => {
    withStore();
    const a = (await issueConsentNonce("user-a")) as { nonce: string };
    const b = (await issueConsentNonce("user-b")) as { nonce: string };
    expect(await consumeConsentNonce("user-a", a.nonce)).toBe(true);
    expect(await consumeConsentNonce("user-b", b.nonce)).toBe(true);
  });
});
