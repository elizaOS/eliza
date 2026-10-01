import { expect, mock, test } from "bun:test";
import { exportJWK, generateKeyPair } from "jose";
import { _resetOidcKeyCacheForTests } from "../oidc/keys";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";
import { MANAGED_CLOUD_OWNER_KEYS } from "./managed-cloud-owner-config";
import {
  findReservedManagedElizaEnvKeys,
  prepareManagedElizaBaseEnvironment,
} from "./managed-eliza-config";

mock.module("./api-keys", () => ({
  apiKeysService: {
    createForAgent: mock(async () => ({
      plainKey: "synthetic-agent-key",
      revokedKeyHashes: [],
    })),
  },
}));
const owner = {
  agentSandboxId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
};
test("provision, restart, transfer and removal preserve owner and isolate confidential client", async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  const env = {
    OIDC_ENABLED: "true",
    OIDC_ISSUER_URL: "https://identity.example.invalid",
    OIDC_SIGNING_JWKS: JSON.stringify([{ ...jwk, kid: "fixture", alg: "ES256" }]),
    ELIZA_CLOUD_AGENT_BASE_DOMAIN: "agents.example.invalid",
    ELIZA_CLOUD_DELEGATION_AGENT_ALLOWLIST: JSON.stringify([
      {
        agentId: owner.agentSandboxId,
        ownerId: owner.userId,
        organizationId: owner.organizationId,
      },
    ]),
    ELIZA_CLOUD_DELEGATION_APP_ID: "44444444-4444-4444-8444-444444444444",
    ELIZA_CLOUD_DELEGATION_CLIENT_ID: "55555555-5555-4555-8555-555555555555",
    ELIZA_CLOUD_DELEGATION_CLIENT_SECRET: "synthetic-client-secret",
    ELIZA_CLOUD_DELEGATION_REDIRECT_URI: "https://phone.example.invalid/delegation-return.html",
    ELIZA_CLOUD_DELEGATION_SITE_URL: "https://cloud.example.invalid",
    ELIZA_CLOUD_DELEGATION_API_URL: "https://api.example.invalid/api/v1",
  };
  const prepare = (
    settings: Record<string, string>,
    identity = owner,
    existingEnv: Record<string, string> = {},
  ) =>
    runWithCloudBindingsAsync(settings, () =>
      prepareManagedElizaBaseEnvironment({ ...identity, existingEnv }),
    );
  try {
    const fresh = await prepare(env);
    expect(fresh.environmentVars).toMatchObject({
      ELIZA_CLOUD_OWNER_ID: owner.userId,
      ELIZA_CLOUD_ORGANIZATION_ID: owner.organizationId,
      ELIZA_CLOUD_AGENT_ID: owner.agentSandboxId,
      ELIZA_CLOUD_OWNER_ISSUER: env.OIDC_ISSUER_URL,
      ELIZA_CLOUD_OWNER_JWKS_URL: env.OIDC_ISSUER_URL + "/.well-known/oidc/jwks.json",
      ELIZA_CLOUD_OWNER_ALGORITHM: "ES256",
      ELIZA_CLOUD_OWNER_AUDIENCE: "https://" + owner.agentSandboxId + ".agents.example.invalid",
      ELIZA_CLOUD_DELEGATION_CLIENT_SECRET: "synthetic-client-secret",
    });
    expect(fresh.environmentVars).not.toHaveProperty("OIDC_SIGNING_JWKS");
    expect(fresh.environmentVars).not.toHaveProperty("ELIZA_CLOUD_DELEGATION_AGENT_ALLOWLIST");
    const poisoned = {
      ...fresh.environmentVars,
      ELIZA_CLOUD_OWNER_ID: "attacker",
      ELIZA_CLOUD_OWNER_AUDIENCE: "https://attacker.invalid",
      ELIZA_CLOUD_DELEGATION_CLIENT_SECRET: "attacker",
    };
    const restart = await prepare(env, owner, poisoned);
    expect(restart.environmentVars.ELIZA_CLOUD_OWNER_ID).toBe(owner.userId);
    expect(restart.environmentVars.ELIZA_CLOUD_DELEGATION_CLIENT_SECRET).toBe(
      "synthetic-client-secret",
    );
    expect(restart.environmentVars.ELIZA_CLOUD_OWNER_AUDIENCE).toBe(
      fresh.environmentVars.ELIZA_CLOUD_OWNER_AUDIENCE,
    );
    const transferred = await prepare(
      env,
      { ...owner, userId: "66666666-6666-4666-8666-666666666666" },
      fresh.environmentVars,
    );
    expect(transferred.environmentVars).not.toHaveProperty("ELIZA_CLOUD_DELEGATION_CLIENT_SECRET");
    expect(transferred.environmentVars.ELIZA_CLOUD_OWNER_ID).toBe(
      "66666666-6666-4666-8666-666666666666",
    );
    const removed = await prepare(
      { ...env, ELIZA_CLOUD_DELEGATION_AGENT_ALLOWLIST: "" },
      owner,
      fresh.environmentVars,
    );
    expect(removed.environmentVars).not.toHaveProperty("ELIZA_CLOUD_DELEGATION_CLIENT_SECRET");
    const disabled = await prepare({ ...env, OIDC_ENABLED: "false" }, owner, fresh.environmentVars);
    for (const key of MANAGED_CLOUD_OWNER_KEYS)
      expect(disabled.environmentVars).not.toHaveProperty(key);
    await expect(prepare({ ...env, ELIZA_CLOUD_DELEGATION_CLIENT_SECRET: "" })).rejects.toThrow(
      "incomplete",
    );
    expect(findReservedManagedElizaEnvKeys(MANAGED_CLOUD_OWNER_KEYS)).toEqual([
      ...MANAGED_CLOUD_OWNER_KEYS,
    ]);
  } finally {
    _resetOidcKeyCacheForTests();
  }
}, 30000);

mock.module("./field-encryption", () => ({
  fieldEncryption: {
    isEncrypted: (value: string) => value.startsWith("enc:v1:"),
    encrypt: mock(
      async (_org: string, value: string) => "enc:v1:" + Buffer.from(value).toString("base64"),
    ),
    decrypt: mock(async (value: string) => Buffer.from(value.slice(7), "base64").toString()),
  },
}));
test("confidential registered-client secret stays encrypted across storage and materialization", async () => {
  const { isSensitiveAgentEnvKey, encryptAgentEnvVarsForStorage, decryptAgentEnvVars } =
    await import("./agent-env-crypto");
  expect(isSensitiveAgentEnvKey("ELIZA_CLOUD_DELEGATION_CLIENT_SECRET")).toBe(true);
  const clear = {
    ELIZA_CLOUD_DELEGATION_CLIENT_SECRET: "synthetic-client-secret",
    ELIZA_CLOUD_DELEGATION_CLIENT_ID: "public-id",
  };
  const previousMasterKey = process.env.SECRETS_MASTER_KEY;
  try {
    process.env.SECRETS_MASTER_KEY = "";
    await expect(encryptAgentEnvVarsForStorage(owner.organizationId, clear)).rejects.toThrow(
      "requires encrypted",
    );
    process.env.SECRETS_MASTER_KEY = "fixture-key-present";
    const stored = await encryptAgentEnvVarsForStorage(owner.organizationId, clear);
    expect(stored.ELIZA_CLOUD_DELEGATION_CLIENT_SECRET).not.toBe(
      clear.ELIZA_CLOUD_DELEGATION_CLIENT_SECRET,
    );
    expect(stored.ELIZA_CLOUD_DELEGATION_CLIENT_ID).toBe("public-id");
    expect(await encryptAgentEnvVarsForStorage(owner.organizationId, stored)).toEqual(stored);
    expect(await decryptAgentEnvVars(stored)).toEqual(clear);
  } finally {
    if (previousMasterKey === undefined) delete process.env.SECRETS_MASTER_KEY;
    else process.env.SECRETS_MASTER_KEY = previousMasterKey;
  }
});
