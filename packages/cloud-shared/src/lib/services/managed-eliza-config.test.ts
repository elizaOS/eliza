import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("./api-keys", () => ({
  apiKeysService: {
    createForAgent: async () => ({ plainKey: "agent-api-key" }),
  },
}));

describe("managed Eliza environment", () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.ELIZA_CLOUD_URL;
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
    delete process.env.ELIZA_CLOUD_API_BASE_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  test("pins managed containers to their cloud agent id for waifu chat JWT scope", async () => {
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
    });

    expect(result.environmentVars.ELIZA_CLOUD_AGENT_ID).toBe("cloud-agent-1");
    expect(result.environmentVars.WAIFU_ELIZA_CLOUD_AGENT_ID).toBe("cloud-agent-1");
  });

  test("preserves waifu-provided hosted UI enablement", async () => {
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
      existingEnv: {
        ELIZA_UI_ENABLE: "true",
      },
    });

    expect(result.environmentVars.ELIZA_UI_ENABLE).toBe("true");
  });

  test("preserves waifu chat auth and frame env for hosted token pages", async () => {
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
      existingEnv: {
        WAIFU_CHAT_ACCESS_JWT_SECRET: "waifu-chat-secret",
        WAIFU_CHAT_FRAME_ANCESTORS: "https://waifu.fun https://staging.waifu.fun",
      },
    });

    expect(result.environmentVars.WAIFU_CHAT_ACCESS_JWT_SECRET).toBe("waifu-chat-secret");
    expect(result.environmentVars.WAIFU_CHAT_FRAME_ANCESTORS).toBe(
      "https://waifu.fun https://staging.waifu.fun",
    );
  });
});
