// Boot-time guard that refuses the ephemeral `memory` KMS backend anywhere it
// could orphan real data (#15310: staging ran memory KMS and lost every org DEK
// on every restart). Real getKmsClient() over the real core KMS
// factory; the deployment signal is driven through the cloud-bindings ALS the
// same way the Worker sets it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { runWithCloudBindings } from "../../lib/runtime/cloud-bindings";
import { getKmsClient, isEphemeralKmsAllowed, resetKmsClientForTests } from "./kms-client";

// A syntactically valid base64 32-byte root key so the `local` backend actually
// constructs instead of failing on a missing key.
const LOCAL_ROOT_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

beforeEach(() => {
  resetKmsClientForTests();
});

afterEach(() => {
  // The singleton is captured on first call; drop the one this file resolved so
  // it cannot leak into other cases in the shared run.
  resetKmsClientForTests();
});

function expectMemoryRefused(bindings: Record<string, string>): void {
  let thrown: unknown;
  try {
    runWithCloudBindings({ ...bindings, ELIZA_KMS_BACKEND: "memory" }, () => getKmsClient());
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ElizaError);
  expect((thrown as ElizaError).code).toBe("KMS_MEMORY_BACKEND_FORBIDDEN");
  expect((thrown as Error).message).toContain("memory");
}

describe("getKmsClient ephemeral-backend guard", () => {
  test("prod + memory backend → throws a classified ElizaError at resolution", () => {
    expectMemoryRefused({ ENVIRONMENT: "production" });
  });

  test("staging + memory backend → throws (the #15310 incident class)", () => {
    // The deployed-environment marker is authoritative even though this test
    // process runs under NODE_ENV=test — a real staging Worker/daemon must
    // never encrypt org DEKs with a key that dies on restart.
    expectMemoryRefused({ ENVIRONMENT: "staging" });
  });

  test("prod via ENVIRONMENT unset but NODE_ENV=production → still throws", () => {
    expectMemoryRefused({ NODE_ENV: "production", ENVIRONMENT: "" });
  });

  test("bare launch (neither ENVIRONMENT nor NODE_ENV) + memory → throws", () => {
    // A daemon/sidecar started without its env file is a real deployment that
    // forgot its config, not a test world.
    expectMemoryRefused({ NODE_ENV: "", ENVIRONMENT: "" });
  });

  test("test env + memory backend → resolves normally (tests legitimately use memory)", () => {
    // NODE_ENV=test in this runner → memory backend, not a deployment → allowed.
    const client = getKmsClient();
    expect(client).toBeDefined();
    expect(typeof client.encrypt).toBe("function");
  });

  test("local dev stack (ENVIRONMENT=local) + memory → resolves normally", () => {
    // cloud-api-dev / sync-api-dev-vars pin ENVIRONMENT=local; the dev stack
    // may run with NODE_ENV=production from wrangler [vars] yet still wants the
    // throwaway backend.
    const client = runWithCloudBindings(
      { ENVIRONMENT: "local", NODE_ENV: "production", ELIZA_KMS_BACKEND: "memory" },
      () => getKmsClient(),
    );
    expect(client).toBeDefined();
    expect(typeof client.encrypt).toBe("function");
  });

  test("prod + local backend (with a root key) → resolves normally", () => {
    const client = runWithCloudBindings(
      {
        ENVIRONMENT: "production",
        ELIZA_KMS_BACKEND: "local",
        ELIZA_LOCAL_ROOT_KEY: LOCAL_ROOT_KEY,
      },
      () => getKmsClient(),
    );
    expect(client).toBeDefined();
    expect(typeof client.decrypt).toBe("function");
  });
});

describe("isEphemeralKmsAllowed", () => {
  test("deployed markers always forbid", () => {
    expect(isEphemeralKmsAllowed({ ENVIRONMENT: "production", NODE_ENV: "test" })).toBe(false);
    expect(isEphemeralKmsAllowed({ ENVIRONMENT: "staging", NODE_ENV: "test" })).toBe(false);
  });

  test("test/development NODE_ENV allows", () => {
    expect(isEphemeralKmsAllowed({ NODE_ENV: "test" })).toBe(true);
    expect(isEphemeralKmsAllowed({ NODE_ENV: "development" })).toBe(true);
  });

  test("explicit local stack allows", () => {
    expect(isEphemeralKmsAllowed({ ENVIRONMENT: "local", NODE_ENV: "production" })).toBe(true);
  });

  test("bare / unknown environments forbid", () => {
    expect(isEphemeralKmsAllowed({})).toBe(false);
    expect(isEphemeralKmsAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(isEphemeralKmsAllowed({ ENVIRONMENT: "preview" })).toBe(false);
  });
});
