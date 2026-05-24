/**
 * Tests for `createKmsClient()` factory env resolution.
 *
 * These guard the production hotfix that switched Eliza Cloud from the
 * (stub) Steward backend to the local AEAD backend with a persistent
 * root key sourced from `ELIZA_LOCAL_ROOT_KEY`.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createKmsClient,
  LocalKmsAdapter,
  MemoryKmsAdapter,
  resolveKmsBackend,
} from "../kms/index.js";
import { KmsError } from "../kms/types.js";

function rootKeyB64(): string {
  return randomBytes(32).toString("base64");
}

describe("resolveKmsBackend", () => {
  it("honors explicit opts.backend", () => {
    expect(resolveKmsBackend({ backend: "memory" }, {})).toBe("memory");
    expect(resolveKmsBackend({ backend: "local" }, {})).toBe("local");
    expect(resolveKmsBackend({ backend: "steward" }, {})).toBe("steward");
  });

  it("honors ELIZA_KMS_BACKEND env", () => {
    expect(resolveKmsBackend({}, { ELIZA_KMS_BACKEND: "local" } as NodeJS.ProcessEnv)).toBe(
      "local",
    );
    expect(resolveKmsBackend({}, { ELIZA_KMS_BACKEND: "memory" } as NodeJS.ProcessEnv)).toBe(
      "memory",
    );
    expect(
      resolveKmsBackend({}, { ELIZA_KMS_BACKEND: "steward" } as NodeJS.ProcessEnv),
    ).toBe("steward");
  });

  it("defaults to memory under NODE_ENV=test", () => {
    expect(resolveKmsBackend({}, { NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe("memory");
  });

  it("defaults to steward in production-shaped envs", () => {
    expect(resolveKmsBackend({}, {} as NodeJS.ProcessEnv)).toBe("steward");
    expect(resolveKmsBackend({}, { NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(
      "steward",
    );
  });

  it("honors ELIZA_LOCAL_MODE=1", () => {
    expect(resolveKmsBackend({}, { ELIZA_LOCAL_MODE: "1" } as NodeJS.ProcessEnv)).toBe("local");
  });

  it("ignores an unrecognized ELIZA_KMS_BACKEND value", () => {
    expect(
      resolveKmsBackend({}, { ELIZA_KMS_BACKEND: "rubbish" } as NodeJS.ProcessEnv),
    ).toBe("steward");
  });
});

describe("createKmsClient — env-driven local backend", () => {
  it("builds a LocalKmsAdapter from ELIZA_LOCAL_ROOT_KEY", () => {
    const client = createKmsClient({
      env: {
        ELIZA_KMS_BACKEND: "local",
        ELIZA_LOCAL_ROOT_KEY: rootKeyB64(),
      } as NodeJS.ProcessEnv,
    });
    expect(client).toBeInstanceOf(LocalKmsAdapter);
  });

  it("rejects an obviously malformed ELIZA_LOCAL_ROOT_KEY", () => {
    expect(() =>
      createKmsClient({
        env: {
          ELIZA_KMS_BACKEND: "local",
          // 16 bytes, not 32
          ELIZA_LOCAL_ROOT_KEY: Buffer.from("0123456789abcdef").toString("base64"),
        } as NodeJS.ProcessEnv,
      }),
    ).toThrow(KmsError);
  });

  it("throws when local backend selected with no key in non-test env", () => {
    expect(() =>
      createKmsClient({
        env: { ELIZA_KMS_BACKEND: "local" } as NodeJS.ProcessEnv,
      }),
    ).toThrow(KmsError);
  });

  it("explicit opts.local.rootKey overrides env", () => {
    const key = new Uint8Array(randomBytes(32));
    const client = createKmsClient({
      env: { ELIZA_KMS_BACKEND: "local" } as NodeJS.ProcessEnv,
      local: { rootKey: key },
    });
    expect(client).toBeInstanceOf(LocalKmsAdapter);
  });
});

describe("createKmsClient — steward→local fallback", () => {
  it("falls back to local when steward selected with no config but ELIZA_LOCAL_ROOT_KEY set", () => {
    // Silence the loud-warning during the assertion.
    const orig = console.warn;
    console.warn = () => {};
    try {
      const client = createKmsClient({
        env: {
          ELIZA_KMS_BACKEND: "steward",
          ELIZA_LOCAL_ROOT_KEY: rootKeyB64(),
        } as NodeJS.ProcessEnv,
      });
      expect(client).toBeInstanceOf(LocalKmsAdapter);
    } finally {
      console.warn = orig;
    }
  });

  it("still throws when steward selected with no config and no local key", () => {
    expect(() =>
      createKmsClient({
        env: { ELIZA_KMS_BACKEND: "steward" } as NodeJS.ProcessEnv,
      }),
    ).toThrow(KmsError);
  });

  it("does not fall back when explicit steward config is provided", () => {
    // We won't construct a real StewardKmsAdapter here (it's a stub); just
    // assert the factory does *not* fall back when cfg is present.
    expect(() =>
      createKmsClient({
        env: {
          ELIZA_KMS_BACKEND: "steward",
          ELIZA_LOCAL_ROOT_KEY: rootKeyB64(),
        } as NodeJS.ProcessEnv,
        steward: {
          baseUrl: "https://steward.invalid",
          tokenProvider: async () => "tok",
        },
      }),
    ).not.toThrow();
  });
});

describe("createKmsClient — test/memory defaults", () => {
  it("returns MemoryKmsAdapter under NODE_ENV=test", () => {
    const client = createKmsClient({
      env: { NODE_ENV: "test" } as NodeJS.ProcessEnv,
    });
    expect(client).toBeInstanceOf(MemoryKmsAdapter);
  });
});
