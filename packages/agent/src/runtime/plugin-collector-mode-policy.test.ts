import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { collectPluginNames } from "./plugin-collector.ts";

const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_LOCAL_LLAMA",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_DISABLE_LOCAL_EMBEDDINGS",
  "ELIZA_BUILD_VARIANT",
  "ELIZA_AGENT_ORCHESTRATOR",
  "OPENAI_API_KEY",
  "OLLAMA_BASE_URL",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("collectPluginNames runtime mode provider policy", () => {
  it("cloud mode exposes only the cloud model provider surface", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";

    const config: ElizaConfig = {
      deploymentTarget: {
        runtime: "cloud",
        provider: "elizacloud",
      },
      cloud: {
        enabled: true,
        apiKey: "cloud-test",
        agentId: "agent-test",
      },
      serviceRouting: {
        llmText: {
          backend: "elizacloud",
          transport: "cloud-proxy",
        },
      },
      plugins: {
        allow: ["local-ai"],
      },
    } as ElizaConfig;

    const names = collectPluginNames(config);

    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
    expect(names.has("@elizaos/plugin-local-embedding")).toBe(false);
    expect(names.has("@elizaos/plugin-openai")).toBe(false);
    expect(names.has("@elizaos/plugin-ollama")).toBe(false);
    expect(names.has("@elizaos/plugin-local-ai")).toBe(false);
  });

  it("remote mode never falls back to cloud or local model providers", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-test";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";

    const config: ElizaConfig = {
      deploymentTarget: {
        runtime: "remote",
        provider: "remote",
        remoteApiBase: "https://api.elizacloud.example",
      },
      cloud: {
        enabled: true,
        apiKey: "cloud-test",
        agentId: "agent-test",
      },
      serviceRouting: {
        llmText: {
          backend: "elizacloud",
          transport: "cloud-proxy",
        },
      },
      plugins: {
        allow: ["local-ai"],
      },
    } as ElizaConfig;

    const names = collectPluginNames(config);

    expect(names.has("@elizaos/plugin-elizacloud")).toBe(false);
    expect(names.has("@elizaos/plugin-local-embedding")).toBe(false);
    expect(names.has("@elizaos/plugin-openai")).toBe(false);
    expect(names.has("@elizaos/plugin-ollama")).toBe(false);
    expect(names.has("@elizaos/plugin-local-ai")).toBe(false);
  });

  it("local-only mode keeps local providers and hides cloud providers", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-test";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";

    const config: ElizaConfig = {
      deploymentTarget: { runtime: "local" },
      cloud: { enabled: false },
    } as ElizaConfig;

    const names = collectPluginNames(config);

    expect(names.has("@elizaos/plugin-local-embedding")).toBe(true);
    expect(names.has("@elizaos/plugin-ollama")).toBe(true);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(false);
  });
});
