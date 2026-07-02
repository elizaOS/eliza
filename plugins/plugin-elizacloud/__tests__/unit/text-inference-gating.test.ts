import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { elizaOSCloudPlugin, registerTextInferenceModels } from "../../src/index";

/**
 * Chat-brain arbitration regression guard (elizaOS/eliza#10819).
 *
 * The plugin used to register its TEXT_* / RESPONSE_HANDLER / ACTION_PLANNER
 * handlers unconditionally in the static `models` map at priority 50, which
 * silently stole the chat brain from priority-0 provider plugins whenever a
 * Cloud key was present. Hosts worked around it by deleting
 * ELIZAOS_CLOUD_API_KEY wholesale — killing Cloud IMAGE/media/TTS as
 * collateral, so "generate an image" hard-failed on any agent whose text brain
 * was an external provider.
 *
 * The contract now: chat-brain handlers register from init() via
 * registerTextInferenceModels, honoring the host-written tri-state
 * ELIZAOS_CLOUD_USE_INFERENCE — explicit "false" skips them (capability-only
 * mode), "true"/unset registers them (cloud brain / standalone use).
 */

const CHAT_BRAIN_SLOTS = [
  String(ModelType.TEXT_NANO ?? "TEXT_NANO"),
  String(ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM"),
  String(ModelType.TEXT_SMALL),
  String(ModelType.TEXT_LARGE),
  String(ModelType.TEXT_MEGA ?? "TEXT_MEGA"),
  String(ModelType.RESPONSE_HANDLER ?? "RESPONSE_HANDLER"),
  String(ModelType.ACTION_PLANNER ?? "ACTION_PLANNER"),
];

function fakeRuntime(settings: Record<string, string | undefined>) {
  const registered: Array<{
    modelType: string;
    provider: string;
    priority?: number;
  }> = [];
  const runtime = {
    getSetting: (key: string) => settings[key],
    registerModel: (modelType: string, _handler: unknown, provider: string, priority?: number) => {
      registered.push({ modelType, provider, priority });
    },
  } as unknown as IAgentRuntime;
  return { runtime, registered };
}

// The plugin's getSetting falls back to process.env; isolate the suite from
// the outer environment so a host-written flag can't skew assertions.
let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env.ELIZAOS_CLOUD_USE_INFERENCE;
  delete process.env.ELIZAOS_CLOUD_USE_INFERENCE;
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.ELIZAOS_CLOUD_USE_INFERENCE;
  else process.env.ELIZAOS_CLOUD_USE_INFERENCE = savedFlag;
});

describe("registerTextInferenceModels — chat-brain arbitration (#10819)", () => {
  it("registers every chat-brain slot when the host sets USE_INFERENCE=true", () => {
    const { runtime, registered } = fakeRuntime({
      ELIZAOS_CLOUD_USE_INFERENCE: "true",
    });
    registerTextInferenceModels(runtime);
    expect(registered.map((r) => r.modelType).sort()).toEqual([...CHAT_BRAIN_SLOTS].sort());
    for (const r of registered) {
      expect(r.provider).toBe(elizaOSCloudPlugin.name);
      expect(r.priority).toBe(elizaOSCloudPlugin.priority);
    }
  });

  it("registers when the flag is unset (standalone plugin use, no host policy)", () => {
    const { runtime, registered } = fakeRuntime({});
    registerTextInferenceModels(runtime);
    expect(registered).toHaveLength(CHAT_BRAIN_SLOTS.length);
  });

  it("registers NOTHING when the host explicitly denies inference (capability-only mode)", () => {
    const { runtime, registered } = fakeRuntime({
      ELIZAOS_CLOUD_USE_INFERENCE: "false",
    });
    registerTextInferenceModels(runtime);
    expect(registered).toHaveLength(0);
  });

  it("keeps capability handlers in the static models map and chat-brain slots out of it", () => {
    const models = elizaOSCloudPlugin.models ?? {};
    // Capabilities that must survive an external text brain:
    expect(models).toHaveProperty(String(ModelType.IMAGE));
    expect(models).toHaveProperty(String(ModelType.IMAGE_DESCRIPTION));
    expect(models).toHaveProperty(String(ModelType.TEXT_TO_SPEECH));
    expect(models).toHaveProperty(String(ModelType.RESEARCH));
    // Embeddings moved OUT of the static map in #11063: they init-register via
    // registerCloudEmbeddingModels so an explicit ELIZAOS_CLOUD_USE_EMBEDDINGS=false
    // lets a BYO embedding provider own TEXT_EMBEDDING (a static registration
    // would always win on plugin priority and 429-loop against the cloud).
    expect(models).not.toHaveProperty(String(ModelType.TEXT_EMBEDDING));
    // Chat-brain slots are init-registered, never static:
    for (const slot of CHAT_BRAIN_SLOTS) {
      expect(models).not.toHaveProperty(slot);
    }
  });
});
