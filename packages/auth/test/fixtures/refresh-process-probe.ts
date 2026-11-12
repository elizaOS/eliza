/** Separate-process credential refresh against the parent's loopback provider. */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createRuntimeAccountStoragePolicy,
  loadAccount,
  saveAccount,
} from "../../src/auth/account-storage.ts";
import { getAccessToken } from "../../src/auth/credentials.ts";

const root = process.env.REFRESH_PROBE_ROOT;
const resultFile = process.env.REFRESH_PROBE_RESULT;
const endpoint = process.env.REFRESH_PROBE_ENDPOINT;
const mode = process.env.REFRESH_PROBE_MODE;
assert(
  root && resultFile && endpoint && mode,
  "Missing refresh probe configuration",
);
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  assert.equal(String(input), "https://auth.openai.com/oauth/token");
  return originalFetch(endpoint, init);
}) as typeof fetch;
const policy = createRuntimeAccountStoragePolicy(root);
try {
  let result: unknown;
  if (mode === "seed") {
    saveAccount(
      {
        id: "shared",
        providerId: "openai-codex",
        label: "Shared fixture",
        source: "oauth",
        credentials: {
          access: "fixture-access",
          refresh: "fixture-refresh",
          expires: 1,
          idToken: "fixture-id-token",
        },
        createdAt: 1,
        updatedAt: 1,
      },
      policy,
    );
    result = { seeded: true };
  } else if (mode === "read") {
    result = loadAccount("openai-codex", "shared", policy);
  } else {
    result = await getAccessToken("openai-codex", "shared", {
      storagePolicy: policy,
      outcome: true,
    });
  }
  fs.writeFileSync(resultFile, JSON.stringify(result));
} finally {
  globalThis.fetch = originalFetch;
}
