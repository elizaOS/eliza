// Cold-start KMS backend preflight (#15310). Drives the real
// `resolveKmsBackend` / `isEphemeralKmsAllowed` policy through an explicit env
// object (no ALS needed — the preflight takes `env` directly) and asserts:
//   1. `evaluateKmsPreflight` classifies backend + durability correctly per env.
//   2. `runKmsColdStartPreflight` emits ONE loud structured `logger.error` with
//      a stable `code` ONLY when a deployed env resolved the ephemeral `memory`
//      backend, and stays SILENT otherwise.
//   3. The preflight NEVER throws (a `createApp()` throw would 1101 every route,
//      health beacon included).
//   4. It never logs key material — only backend class + env markers.

import { beforeEach, describe, expect, mock, test } from "bun:test";

const errorMock = mock();
const warnMock = mock();
const infoMock = mock();
mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: errorMock,
    warn: warnMock,
    info: infoMock,
    debug: mock(),
  },
}));

import {
  evaluateKmsPreflight,
  resetKmsPreflightOnceForTests,
  runKmsColdStartPreflight,
  runKmsPreflightOnce,
} from "./kms-preflight";

// A syntactically valid base64 32-byte root key so the `local` backend is a
// realistic, fully-configured value (the preflight never constructs an adapter,
// but keeping the env realistic guards against future coupling).
const LOCAL_ROOT_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64",
);

beforeEach(() => {
  errorMock.mockClear();
  warnMock.mockClear();
  infoMock.mockClear();
  resetKmsPreflightOnceForTests();
});

describe("evaluateKmsPreflight — backend + durability classification", () => {
  test("staging + memory backend → memory, NOT durable (the #15310 class)", () => {
    const r = evaluateKmsPreflight({
      ENVIRONMENT: "staging",
      ELIZA_KMS_BACKEND: "memory",
    } as NodeJS.ProcessEnv);
    expect(r.backend).toBe("memory");
    expect(r.durable).toBe(false);
    expect(r.environment).toBe("staging");
  });

  test("production + memory backend → memory, NOT durable", () => {
    const r = evaluateKmsPreflight({
      ENVIRONMENT: "production",
      ELIZA_KMS_BACKEND: "memory",
    } as NodeJS.ProcessEnv);
    expect(r.backend).toBe("memory");
    expect(r.durable).toBe(false);
  });

  test("staging + local backend + valid key → local, durable", () => {
    const r = evaluateKmsPreflight({
      ENVIRONMENT: "staging",
      ELIZA_KMS_BACKEND: "local",
      ELIZA_LOCAL_ROOT_KEY: LOCAL_ROOT_KEY,
    } as NodeJS.ProcessEnv);
    expect(r.backend).toBe("local");
    expect(r.durable).toBe(true);
    expect(r.reason).toBeNull();
  });

  test("staging + local backend + MISSING key → local, NOT durable (would 500 at the crypto path)", () => {
    // Regression guard for the usability gap: a name-only check reported this
    // durable while `getKmsClient()` throws on the first crypto call.
    const r = evaluateKmsPreflight({
      ENVIRONMENT: "staging",
      ELIZA_KMS_BACKEND: "local",
    } as NodeJS.ProcessEnv);
    expect(r.backend).toBe("local");
    expect(r.durable).toBe(false);
    expect(r.reason).toContain("local");
  });

  test("staging + local backend + MALFORMED key → local, NOT durable", () => {
    const r = evaluateKmsPreflight({
      ENVIRONMENT: "staging",
      ELIZA_KMS_BACKEND: "local",
      // Not valid base64 / wrong length — the factory's decodeRootKey rejects it.
      ELIZA_LOCAL_ROOT_KEY: "not-a-valid-32-byte-base64-key!!!",
    } as NodeJS.ProcessEnv);
    expect(r.backend).toBe("local");
    expect(r.durable).toBe(false);
    // The reason carries the factory's error message, never the key value.
    expect(r.reason).not.toContain("not-a-valid-32-byte-base64-key");
  });

  test("production + steward backend WITHOUT config → steward, NOT durable (no usable client)", () => {
    // `createKmsClient` throws for steward without steward.{baseUrl,tokenProvider}
    // UNLESS a local root key is present (the security factory then falls back
    // to local). With neither, the client is unusable — correctly non-durable.
    const r = evaluateKmsPreflight({
      ENVIRONMENT: "production",
      ELIZA_KMS_BACKEND: "steward",
    } as NodeJS.ProcessEnv);
    expect(r.backend).toBe("steward");
    expect(r.durable).toBe(false);
    expect(r.reason).toContain("steward");
  });

  test("production + steward selected but only a local key present → falls back to local, durable", () => {
    // Mirrors the security factory's production-safety fallback: steward with no
    // config but a provisioned ELIZA_LOCAL_ROOT_KEY resolves to a usable local
    // client, so the preflight must report durable.
    const r = evaluateKmsPreflight({
      ENVIRONMENT: "production",
      ELIZA_KMS_BACKEND: "steward",
      ELIZA_LOCAL_ROOT_KEY: LOCAL_ROOT_KEY,
    } as NodeJS.ProcessEnv);
    expect(r.durable).toBe(true);
    expect(r.reason).toBeNull();
  });

  test("test env + memory backend → memory, durable (ephemeral allowed in test)", () => {
    const r = evaluateKmsPreflight({
      NODE_ENV: "test",
      ELIZA_KMS_BACKEND: "memory",
    } as NodeJS.ProcessEnv);
    expect(r.backend).toBe("memory");
    // In test/development the ephemeral backend is an expected default, so it is
    // classified durable-enough (no alarm) for this environment.
    expect(r.durable).toBe(true);
  });

  test("local env + memory backend → memory, durable (dev default, no alarm)", () => {
    const r = evaluateKmsPreflight({
      ENVIRONMENT: "local",
      ELIZA_KMS_BACKEND: "memory",
    } as NodeJS.ProcessEnv);
    expect(r.backend).toBe("memory");
    expect(r.durable).toBe(true);
  });
});

describe("runKmsColdStartPreflight — loud-on-misconfig, silent otherwise", () => {
  test("staging + memory → emits exactly one logger.error with the stable code", () => {
    const r = runKmsColdStartPreflight({
      ENVIRONMENT: "staging",
      ELIZA_KMS_BACKEND: "memory",
    } as NodeJS.ProcessEnv);

    expect(r.durable).toBe(false);
    expect(errorMock).toHaveBeenCalledTimes(1);

    const [message, context] = errorMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toContain("[kms-preflight]");
    expect(context.code).toBe("KMS_NON_DURABLE_BACKEND");
    expect(context.backend).toBe("memory");
    expect(context.environment).toBe("staging");
    expect(context.reason).toContain("memory");
  });

  test("staging + local + missing key → emits the loud error (non-durable via usability gate, not just memory)", () => {
    const r = runKmsColdStartPreflight({
      ENVIRONMENT: "staging",
      ELIZA_KMS_BACKEND: "local",
    } as NodeJS.ProcessEnv);
    expect(r.durable).toBe(false);
    expect(errorMock).toHaveBeenCalledTimes(1);
    const [, context] = errorMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(context.code).toBe("KMS_NON_DURABLE_BACKEND");
    expect(context.backend).toBe("local");
    expect(context.reason).toContain("local");
  });

  test("production + memory → emits the loud error", () => {
    runKmsColdStartPreflight({
      ENVIRONMENT: "production",
      ELIZA_KMS_BACKEND: "memory",
    } as NodeJS.ProcessEnv);
    expect(errorMock).toHaveBeenCalledTimes(1);
    const [, context] = errorMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(context.code).toBe("KMS_NON_DURABLE_BACKEND");
    expect(context.environment).toBe("production");
  });

  test("staging + local → SILENT (durable backend, no false alarm)", () => {
    const r = runKmsColdStartPreflight({
      ENVIRONMENT: "staging",
      ELIZA_KMS_BACKEND: "local",
      ELIZA_LOCAL_ROOT_KEY: LOCAL_ROOT_KEY,
    } as NodeJS.ProcessEnv);
    expect(r.durable).toBe(true);
    expect(errorMock).not.toHaveBeenCalled();
  });

  test("test env + memory → SILENT (dev/test default is not a misconfig)", () => {
    runKmsColdStartPreflight({
      NODE_ENV: "test",
      ELIZA_KMS_BACKEND: "memory",
    } as NodeJS.ProcessEnv);
    expect(errorMock).not.toHaveBeenCalled();
  });

  test("ENVIRONMENT unset + memory (a launch that forgot its config) → LOUD (matches the shared policy, not a narrower env gate)", () => {
    // Regression guard for the over-gating bug: a bare launch that resolves the
    // memory backend with no ENVIRONMENT marker is still fatal per
    // `isEphemeralKmsAllowed`; the preflight must not go silent just because
    // ENVIRONMENT is not exactly staging/production.
    const r = runKmsColdStartPreflight({
      ELIZA_KMS_BACKEND: "memory",
    } as NodeJS.ProcessEnv);
    expect(r.durable).toBe(false);
    expect(errorMock).toHaveBeenCalledTimes(1);
    const [, context] = errorMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(context.code).toBe("KMS_NON_DURABLE_BACKEND");
  });

  test("NEVER throws — even on the fatal-misconfig path it returns a result", () => {
    let thrown: unknown;
    let result: ReturnType<typeof runKmsColdStartPreflight> | undefined;
    try {
      result = runKmsColdStartPreflight({
        ENVIRONMENT: "production",
        ELIZA_KMS_BACKEND: "memory",
      } as NodeJS.ProcessEnv);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeUndefined();
    expect(result?.backend).toBe("memory");
    expect(result?.durable).toBe(false);
  });

  test("never logs key material — ELIZA_LOCAL_ROOT_KEY is absent from the log context", () => {
    // Force the loud path but with a root key present in env; the log context
    // must only carry backend class + env markers, never the key.
    runKmsColdStartPreflight({
      ENVIRONMENT: "production",
      ELIZA_KMS_BACKEND: "memory",
      ELIZA_LOCAL_ROOT_KEY: LOCAL_ROOT_KEY,
    } as NodeJS.ProcessEnv);
    expect(errorMock).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(errorMock.mock.calls[0]);
    expect(serialized).not.toContain(LOCAL_ROOT_KEY);
  });
});

describe("runKmsPreflightOnce — at-most-once-per-isolate guard", () => {
  const badEnv = {
    ENVIRONMENT: "staging",
    ELIZA_KMS_BACKEND: "memory",
  } as NodeJS.ProcessEnv;

  test("logs on the first call, stays silent on subsequent calls", () => {
    runKmsPreflightOnce(badEnv);
    runKmsPreflightOnce(badEnv);
    runKmsPreflightOnce(badEnv);
    // Even though every call resolves the fatal memory backend, the loud line is
    // emitted exactly once — a cold-start-style signal, not a per-request storm.
    expect(errorMock).toHaveBeenCalledTimes(1);
  });

  test("resetKmsPreflightOnceForTests re-arms the guard", () => {
    runKmsPreflightOnce(badEnv);
    expect(errorMock).toHaveBeenCalledTimes(1);
    resetKmsPreflightOnceForTests();
    runKmsPreflightOnce(badEnv);
    expect(errorMock).toHaveBeenCalledTimes(2);
  });

  test("never throws", () => {
    let thrown: unknown;
    try {
      runKmsPreflightOnce(badEnv);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeUndefined();
  });
});
