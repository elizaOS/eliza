/**
 * Exercises detectRuntimeModel's cloud-proxy branch: the resolver must only
 * report "elizacloud" when the cloud plugin actually registered its chat-brain
 * text handler, so /api/status reflects the handler serving requests instead
 * of a cloud-proxy config that silently fell through to local inference
 * (elizaOS/eliza#20045). Deterministic — no real runtime, no network.
 */
import type { AgentRuntime, ModelRegistrationInfo } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { detectRuntimeModel } from "./agent-model";

const ELIZA_CLOUD_PROVIDER_NAME = "elizaOSCloud";
const LOCAL_INFERENCE_PROVIDER_NAME = "eliza-local-inference";

type RuntimeOpts = {
  cloudTextHandlerRegistered?: boolean;
  localTextHandlerRegistered?: boolean;
  plugins?: Array<{ name: string }>;
  characterModel?: string;
  /** Provider core recorded as having served the last chat call. */
  lastServingProvider?: string;
  settings?: Record<string, string>;
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
    getLastResolvedModelProvider: () => opts.lastServingProvider,
    getSetting: (key: string) => opts.settings?.[key],
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

  it("falls back to the character model when nothing has served yet", () => {
    const runtime = makeRuntime({
      cloudTextHandlerRegistered: false,
      characterModel: "my-custom-model",
    });
    expect(detectRuntimeModel(runtime, cloudProxyConfig)).toBe(
      "my-custom-model",
    );
  });

  // Regression cluster for the #20124 review: a character `model` pin is a
  // request, not a receipt. Preferring it made /api/status report "elizacloud"
  // while local inference actually answered every turn.
  it("prefers the provider that actually served over a character pin", () => {
    const runtime = makeRuntime({
      characterModel: "elizacloud",
      lastServingProvider: "eliza-local-inference",
    });
    expect(detectRuntimeModel(runtime, cloudProxyConfig)).toBe(
      "eliza-local-inference",
    );
  });

  it("prefers the serving provider over a registered-but-losing cloud handler", () => {
    // Cloud has a handler registered, but another provider answered — the
    // registration is availability, not evidence.
    const runtime = makeRuntime({
      cloudTextHandlerRegistered: true,
      lastServingProvider: "eliza-local-inference",
    });
    expect(detectRuntimeModel(runtime, cloudProxyConfig)).toBe(
      "eliza-local-inference",
    );
  });

  it("reports elizacloud once a Cloud handler has actually served", () => {
    const runtime = makeRuntime({
      cloudTextHandlerRegistered: true,
      lastServingProvider: ELIZA_CLOUD_PROVIDER_NAME,
    });
    expect(detectRuntimeModel(runtime, cloudProxyConfig)).toBe(
      ELIZA_CLOUD_PROVIDER_NAME,
    );
  });

  it("reports the concrete Cerebras backend behind the OpenAI-compatible handler", () => {
    const runtime = makeRuntime({
      lastServingProvider: "openai",
      settings: { ELIZA_PROVIDER: "cerebras" },
    });
    expect(detectRuntimeModel(runtime, cloudProxyConfig)).toBe("cerebras");
  });

  it("keeps genuine OpenAI serving truth when no compatible backend is selected", () => {
    const runtime = makeRuntime({
      lastServingProvider: "openai",
      settings: { OPENAI_API_KEY: "present" },
    });
    expect(detectRuntimeModel(runtime, cloudProxyConfig)).toBe("openai");
  });

  it("uses the same process-environment provider fallback as the compatible handler", () => {
    vi.stubEnv("ELIZA_PROVIDER", "cerebras");
    try {
      const runtime = makeRuntime({ lastServingProvider: "openai" });
      expect(detectRuntimeModel(runtime, cloudProxyConfig)).toBe("cerebras");
    } finally {
      vi.unstubAllEnvs();
    }
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

// The exact packaged-app state quoted in the #20124 review: cloud-proxy
// configured, character pinned to elizacloud, account signed out, local
// inference actually answering. /api/status reported "elizacloud" here.
const reproducedUnsignedCloudProxy = {
  serviceRouting: {
    llmText: {
      backend: "elizacloud",
      transport: "cloud-proxy" as const,
      accountId: "elizacloud",
    },
  },
};

describe("detectRuntimeModel — the #20124 reproduced state", () => {
  it("no longer reports elizacloud once local inference has served a turn", () => {
    const runtime = makeRuntime({
      characterModel: "elizacloud",
      localTextHandlerRegistered: true,
      lastServingProvider: LOCAL_INFERENCE_PROVIDER_NAME,
    });
    const model = detectRuntimeModel(runtime, reproducedUnsignedCloudProxy);
    expect(model).toBe(LOCAL_INFERENCE_PROVIDER_NAME);
    expect(model).not.toBe("elizacloud");
  });
});
