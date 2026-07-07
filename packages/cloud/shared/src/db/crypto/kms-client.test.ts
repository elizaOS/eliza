// Boot-time guard that refuses the ephemeral `memory` KMS backend in production.
// Real getKmsClient() over the real @elizaos/security factory; the prod signal is
// driven through the cloud-bindings ALS the same way the Worker sets it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { runWithCloudBindings } from "../../lib/runtime/cloud-bindings";
import { getKmsClient, resetKmsClientForTests } from "./kms-client";

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

describe("getKmsClient production guard", () => {
  test("prod + memory backend → throws a classified ElizaError at resolution", () => {
    let thrown: unknown;
    try {
      runWithCloudBindings({ ENVIRONMENT: "production", ELIZA_KMS_BACKEND: "memory" }, () =>
        getKmsClient(),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ElizaError);
    expect((thrown as ElizaError).code).toBe("KMS_MEMORY_BACKEND_IN_PRODUCTION");
    expect((thrown as Error).message).toContain("memory");
  });

  test("prod + memory via ENVIRONMENT unset but NODE_ENV=production → still throws", () => {
    // The prod signal falls back to NODE_ENV when ENVIRONMENT is absent (local
    // Node runs), so the guard must fire on that path too.
    let thrown: unknown;
    try {
      runWithCloudBindings({ NODE_ENV: "production", ELIZA_KMS_BACKEND: "memory" }, () =>
        getKmsClient(),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ElizaError);
    expect((thrown as ElizaError).code).toBe("KMS_MEMORY_BACKEND_IN_PRODUCTION");
  });

  test("test env + memory backend → resolves normally (tests legitimately use memory)", () => {
    // NODE_ENV=test in this runner → memory backend, not production → allowed.
    const client = getKmsClient();
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
