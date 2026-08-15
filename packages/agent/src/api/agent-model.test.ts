/**
 * Exercises detectRuntimeModel's cloud-proxy branch: the resolver must only
 * report "elizacloud" when the cloud plugin actually registered its chat-brain
 * text handler, so /api/status reflects the handler serving requests instead
 * of a cloud-proxy config that silently fell through to local inference
 * (elizaOS/eliza#20045). Deterministic — no real runtime, no network.
 */
import type { AgentRuntime, ModelRegistrationInfo } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { detectRuntimeModel } from "./agent-model";

const ELIZA_CLOUD_PROVIDER_NAME = "elizaOSCloud";
const LOCAL_INFERENCE_PROVIDER_NAME = "eliza-local-inference";

type RuntimeOpts = {
  cloudTextHandlerRegistered?: boolean;
  localTextHandlerRegistered?: boolean;
  plugins?: Array<{ name: string }>;
  characterModel?: string;
};

function makeRuntime(opts: RuntimeOpts = {}): AgentRuntime {
  const registrations: ModelRegistrationInfo[] = [];
  if (opts.cloudTextHandlerRegistered) {
    registrations.push({
      modelType: ModelType.TEXT_SMALL,
      provider: ELIZA_CLOUD_PROVIDER_NAME,
      priority: 50,
      registrationOrder: 1,
    });
  }
  if (opts.localTextHandlerRegistered) {
    registrations.push({
      modelType: ModelType.TEXT_SMALL,
      provider: LOCAL_INFERENCE_PROVIDER_NAME,
      priority: 0,
      registrationOrder: 2,
    });
  }
  const runtime = {
    plugins: opts.plugins ?? [],
    getModelRegistrations: () => registrations,
    character: opts.characterModel ? { model: opts.characterModel } : {},
  } as unknown as AgentRuntime;
  return runtime;
}

const cloudProxyConfig = {
  serviceRouting: {
    llmText: {
      backend: "elizacloud",
      transport: "cloud-proxy" as const,
      accountId: "elizacloud",
    },
  },
};

describe("detectRuntimeModel — cloud-proxy branch", () => {
  it("returns elizacloud when the cloud text handler is registered", () => {
    const runtime = makeRuntime({ cloudTextHandlerRegistered: true });
    expect(detectRuntimeModel(runtime, cloudProxyConfig)).toBe("elizacloud");
  });

  it("falls through when cloud-proxy is configured but no cloud handler is registered", () => {
    // Reproduces #20045: cloud-proxy config + no ELIZAOS_CLOUD_API_KEY →
    // plugin skips handler registration → runtime falls back to local.
    const runtime = makeRuntime({
      cloudTextHandlerRegistered: false,
      localTextHandlerRegistered: true,
      plugins: [{ name: "plugin-local-inference" }],
    });
    const model = detectRuntimeModel(runtime, cloudProxyConfig);
    expect(model).not.toBe("elizacloud");
    // Falls through to the plugin-name path (PROVIDER_HINTS includes none of
    // the local-inference plugin names, so the env-signal path is reached).
    // Without ELIZA_LOCAL_LLAMA or any provider env var set, returns undefined.
    expect(model).toBeUndefined();
  });

  it("falls through to a local provider plugin name when cloud handlers are absent", () => {
    const runtime = makeRuntime({
      cloudTextHandlerRegistered: false,
      plugins: [{ name: "anthropic" }],
    });
    expect(detectRuntimeModel(runtime, cloudProxyConfig)).toBe("anthropic");
  });

  it("returns elizacloud even when local handlers are also registered (cloud wins)", () => {
    const runtime = makeRuntime({
      cloudTextHandlerRegistered: true,
      localTextHandlerRegistered: true,
    });
    expect(detectRuntimeModel(runtime, cloudProxyConfig)).toBe("elizacloud");
  });
});

describe("detectRuntimeModel — non-cloud branches unaffected", () => {
  it("returns undefined when no runtime is provided", () => {
    expect(detectRuntimeModel(null, cloudProxyConfig)).toBeUndefined();
  });

  it("returns the character model when set, regardless of cloud-proxy config", () => {
    const runtime = makeRuntime({
      cloudTextHandlerRegistered: false,
      characterModel: "my-custom-model",
    });
    expect(detectRuntimeModel(runtime, cloudProxyConfig)).toBe(
      "my-custom-model",
    );
  });

  it("returns the direct-transport primary model", () => {
    const runtime = makeRuntime();
    const directConfig = {
      serviceRouting: {
        llmText: {
          backend: "openai",
          transport: "direct" as const,
          primaryModel: "gpt-4o",
        },
      },
    };
    expect(detectRuntimeModel(runtime, directConfig)).toBe("gpt-4o");
  });
});
