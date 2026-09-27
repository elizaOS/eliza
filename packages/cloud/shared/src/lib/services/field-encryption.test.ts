// Verifies the fail-closed field-encryption flags (AAD-required writes, required agent-env encryption).
import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("@/lib/utils/logger", () => ({
  logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
}));

const { FieldEncryptionService, isFieldEncryptionRequired } = await import("./field-encryption");
const { encryptAgentEnvVarsForStorage } = await import("./agent-env-crypto");

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SAVED = {
  FIELD_ENCRYPTION_REQUIRE_AAD: process.env.FIELD_ENCRYPTION_REQUIRE_AAD,
  FIELD_ENCRYPTION_REQUIRED: process.env.FIELD_ENCRYPTION_REQUIRED,
  ENVIRONMENT: process.env.ENVIRONMENT,
  SECRETS_MASTER_KEY: process.env.SECRETS_MASTER_KEY,
};

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("FIELD_ENCRYPTION_REQUIRE_AAD", () => {
  test("rejects a coordinate-less write before touching keys or the database", async () => {
    process.env.FIELD_ENCRYPTION_REQUIRE_AAD = "true";
    delete process.env.SECRETS_MASTER_KEY;
    const error = await rejection(new FieldEncryptionService().encrypt(ORG_ID, "secret"));
    expect(error).toMatchObject({ code: "FIELD_ENCRYPTION_AAD_REQUIRED" });
  });

  test("leaves coordinate-less writes on the legacy path when unset", async () => {
    delete process.env.FIELD_ENCRYPTION_REQUIRE_AAD;
    delete process.env.SECRETS_MASTER_KEY;
    const error = await rejection(new FieldEncryptionService().encrypt(ORG_ID, "secret"));
    // Reaches key initialization (and fails there) instead of the AAD gate.
    expect((error as Error).message).toContain("SECRETS_MASTER_KEY must be set");
  });
});

describe("required agent-env encryption", () => {
  test("deployed environments and the explicit flag require encryption", () => {
    expect(isFieldEncryptionRequired({ ENVIRONMENT: "production" })).toBe(true);
    expect(isFieldEncryptionRequired({ ENVIRONMENT: "staging" })).toBe(true);
    expect(isFieldEncryptionRequired({ FIELD_ENCRYPTION_REQUIRED: "true" })).toBe(true);
    expect(isFieldEncryptionRequired({ ENVIRONMENT: "local", NODE_ENV: "development" })).toBe(
      false,
    );
    expect(isFieldEncryptionRequired({})).toBe(false);
  });

  test("throws instead of storing plaintext secrets when encryption is required", async () => {
    delete process.env.SECRETS_MASTER_KEY;
    process.env.ENVIRONMENT = "production";
    const error = await rejection(
      encryptAgentEnvVarsForStorage(ORG_ID, { OPENAI_API_KEY: "sk-live", LOG_LEVEL: "info" }),
    );
    expect(error).toMatchObject({ code: "AGENT_ENV_ENCRYPTION_REQUIRED" });
    expect((error as Error).message).not.toContain("sk-live");
  });

  test("keeps the legacy plaintext path for local development", async () => {
    delete process.env.SECRETS_MASTER_KEY;
    delete process.env.FIELD_ENCRYPTION_REQUIRED;
    process.env.ENVIRONMENT = "local";
    const stored = await encryptAgentEnvVarsForStorage(ORG_ID, { OPENAI_API_KEY: "sk-dev" });
    expect(stored).toEqual({ OPENAI_API_KEY: "sk-dev" });
  });
});
