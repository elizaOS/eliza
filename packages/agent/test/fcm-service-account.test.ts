/**
 * FCM credential gating: an absent credential means "push is off", but a
 * credential that is present and unusable is a deployment error and must not
 * be reported as "not configured".
 */
import { ElizaError } from "@elizaos/core";
import { expect, it } from "vitest";
import { readServiceAccount } from "../src/services/push/fcm-provider.ts";

const VALID = JSON.stringify({
  client_email: "push@example.invalid",
  project_id: "fixture-project",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n",
});

function credentialError(env: NodeJS.ProcessEnv): ElizaError {
  try {
    readServiceAccount(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ElizaError);
    return error as ElizaError;
  }
  throw new Error("expected readServiceAccount to reject the credential");
}

it("treats an absent credential as not configured", () => {
  expect(readServiceAccount({})).toBeNull();
  expect(readServiceAccount({ ELIZA_FCM_SERVICE_ACCOUNT: "   " })).toBeNull();
});

it("rejects a configured-but-unparseable service account", () => {
  const error = credentialError({
    ELIZA_FCM_SERVICE_ACCOUNT: '{"client_email":',
  });
  expect(error.code).toBe("FCM_SERVICE_ACCOUNT_INVALID");
  expect(error.context?.source).toBe("ELIZA_FCM_SERVICE_ACCOUNT");
});

it("rejects a parsed service account that is missing required fields", () => {
  const error = credentialError({
    ELIZA_FCM_SERVICE_ACCOUNT: JSON.stringify({
      client_email: "push@example.invalid",
    }),
  });
  expect(error.code).toBe("FCM_SERVICE_ACCOUNT_INVALID");
});

it("still accepts a complete service account", () => {
  const account = readServiceAccount({ ELIZA_FCM_SERVICE_ACCOUNT: VALID });
  expect(account?.client_email).toBe("push@example.invalid");
  expect(account?.project_id).toBe("fixture-project");
});
