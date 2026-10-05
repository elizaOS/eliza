import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  env: {} as Record<string, string>,
  encrypt: vi.fn(
    async (_org: string, value: string) =>
      `enc:v1:test:${Buffer.from(value).toString("hex")}`,
  ),
}));
vi.mock("../../../cloud/shared/src/lib/runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => state.env,
}));
vi.mock("../../../cloud/shared/src/lib/services/field-encryption", () => ({
  fieldEncryption: { encrypt: state.encrypt },
}));
vi.mock("../../../cloud/shared/src/lib/services/managed-eliza-config", () => ({
  prepareManagedElizaSharedEnvironment: async ({
    existingEnv,
  }: {
    existingEnv: Record<string, string>;
  }) => ({
    environmentVars: { ...existingEnv },
    agentApiKey: null,
    revokedKeyHashes: [],
  }),
}));
vi.mock("../../../cloud/shared/src/lib/steward-url", () => ({
  resolveServerStewardApiUrlFromEnv: () => {
    throw new Error("No steward in fixture");
  },
}));
vi.mock("../../../cloud/shared/src/lib/services/docker-sandbox-utils", () => ({
  resolveStewardContainerUrl: () => undefined,
}));

import { prepareManagedElizaEnvironment } from "../../../cloud/shared/src/lib/services/managed-eliza-env";

const params = {
  organizationId: "org-owner",
  userId: "user-owner",
  sandboxId: "sandbox-one",
};

describe("managed encryption provisioning", () => {
  beforeEach(() => {
    state.env = { SECRETS_MASTER_KEY: "configured" };
    state.encrypt.mockClear();
  });
  it("persists independent high-entropy salts only through tenant encryption", async () => {
    const result = await prepareManagedElizaEnvironment(params);
    expect(state.encrypt).toHaveBeenCalledTimes(2);
    const values = state.encrypt.mock.calls.map(([org, value]) => {
      expect(org).toBe(params.organizationId);
      expect(Buffer.from(value, "base64url")).toHaveLength(32);
      expect(JSON.stringify(result.environmentVars)).not.toContain(value);
      return value;
    });
    expect(values[0]).not.toBe(values[1]);
    expect(result.environmentVars.SECRET_SALT).toMatch(/^enc:v1:/);
    expect(result.environmentVars.ENCRYPTION_SALT).toMatch(/^enc:v1:/);
    expect(result.environmentVars.ELIZA_RUNTIME_OWNER_ID).toBe(params.userId);
  });
  it("preserves existing salts exactly so restart does not lose encrypted state", async () => {
    const existingEnv = {
      SECRET_SALT: "enc:v1:existing-settings",
      ENCRYPTION_SALT: "enc:v1:existing-vault",
    };
    const result = await prepareManagedElizaEnvironment({
      ...params,
      existingEnv,
    });
    expect(result.environmentVars).toMatchObject(existingEnv);
    expect(state.encrypt).not.toHaveBeenCalled();
  });
  it("does not generate plaintext salts when managed encryption is unavailable", async () => {
    state.env = {};
    const result = await prepareManagedElizaEnvironment(params);
    expect(result.environmentVars.SECRET_SALT).toBeUndefined();
    expect(result.environmentVars.ENCRYPTION_SALT).toBeUndefined();
    expect(state.encrypt).not.toHaveBeenCalled();
  });
});
