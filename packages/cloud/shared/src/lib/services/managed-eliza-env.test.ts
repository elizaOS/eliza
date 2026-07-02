import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("./api-keys", () => ({
  apiKeysService: {
    createForAgent: async () => ({ plainKey: "agent-api-key" }),
  },
}));

const KEYS = [
  "STEWARD_API_URL",
  "STEWARD_CONTAINER_URL",
  "STEWARD_KEYLESS_HOSTED_AGENTS",
  "STEWARD_KEYLESS_OPENAI",
  "STEWARD_KEYLESS_FALLBACK_RAW_ENV",
  "STEWARD_KEYLESS_OPENAI_CAPABILITY",
  "STEWARD_KEYLESS_OPENAI_BASE_URL",
  "NEXT_PUBLIC_STEWARD_API_URL",
  "NEXT_PUBLIC_API_URL",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("managed keyless OpenAI env", () => {
  test("keyless disabled preserves legacy OPENAI_API_KEY", async () => {
    process.env.STEWARD_API_URL = "https://steward.example/api";
    const { prepareManagedElizaEnvironment } = await import("./managed-eliza-env");

    const result = await prepareManagedElizaEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      sandboxId: "agent-1",
      existingEnv: { OPENAI_API_KEY: "sk-real-test" },
    });

    expect(result.environmentVars.OPENAI_API_KEY).toBe("sk-real-test");
    expect(result.environmentVars.STEWARD_KEYLESS_MODE).toBeUndefined();
  });

  test("keyless enabled with fallback true preserves the raw key by policy", async () => {
    process.env.STEWARD_API_URL = "https://steward.example/api";
    process.env.STEWARD_KEYLESS_HOSTED_AGENTS = "true";
    process.env.STEWARD_KEYLESS_OPENAI = "true";
    process.env.STEWARD_KEYLESS_FALLBACK_RAW_ENV = "true";
    const { prepareManagedElizaEnvironment } = await import("./managed-eliza-env");

    const result = await prepareManagedElizaEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      sandboxId: "agent-1",
      existingEnv: { OPENAI_API_KEY: "sk-real-test" },
    });

    expect(result.environmentVars.OPENAI_API_KEY).toBe("sk-real-test");
    expect(result.environmentVars.STEWARD_KEYLESS_MODE).toBeUndefined();
  });

  test("keyless enabled with fallback disabled strips raw key and sets adapter base URL", async () => {
    process.env.STEWARD_API_URL = "https://steward.example/api";
    process.env.STEWARD_KEYLESS_HOSTED_AGENTS = "true";
    process.env.STEWARD_KEYLESS_OPENAI = "true";
    process.env.STEWARD_KEYLESS_FALLBACK_RAW_ENV = "false";
    const { prepareManagedElizaEnvironment } = await import("./managed-eliza-env");

    const result = await prepareManagedElizaEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      sandboxId: "agent-1",
      existingEnv: { OPENAI_API_KEY: "sk-real-test" },
    });

    expect(result.environmentVars.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(result.environmentVars)).not.toContain("sk-real-test");
    expect(result.environmentVars.STEWARD_KEYLESS_MODE).toBe("capability-openai");
    expect(result.environmentVars.STEWARD_KEYLESS_SERVICES).toBe("openai");
    expect(result.environmentVars.STEWARD_CAP_OPENAI_CHAT).toBe("openai.chat.completions");
    expect(result.environmentVars.OPENAI_BASE_URL).toBe(
      "https://steward.example/api/capabilities/openai.chat.completions/openai/v1",
    );
  });

  test("container overlay uses Steward auth token as plugin-openai bearer", async () => {
    process.env.STEWARD_KEYLESS_HOSTED_AGENTS = "true";
    process.env.STEWARD_KEYLESS_OPENAI = "true";
    const { buildKeylessOpenAIContainerEnv } = await import("./managed-eliza-env");

    const env = buildKeylessOpenAIContainerEnv({
      stewardApiUrl: "https://steward.example/api/",
      stewardAuthToken: "steward-agent-token",
    });

    expect(env.OPENAI_API_KEY).toBe("steward-agent-token");
    expect(env.OPENAI_BASE_URL).toBe(
      "https://steward.example/api/capabilities/openai.chat.completions/openai/v1",
    );
  });

  test("keyless fallback disabled fails closed when Steward URL is unavailable", async () => {
    process.env.STEWARD_KEYLESS_HOSTED_AGENTS = "true";
    process.env.STEWARD_KEYLESS_OPENAI = "true";
    const { prepareManagedElizaEnvironment } = await import("./managed-eliza-env");

    await expect(
      prepareManagedElizaEnvironment({
        organizationId: "org-1",
        userId: "user-1",
        sandboxId: "agent-1",
        existingEnv: { OPENAI_API_KEY: "sk-real-test" },
      }),
    ).rejects.toThrow(/Steward API URL is required/);
  });
});
