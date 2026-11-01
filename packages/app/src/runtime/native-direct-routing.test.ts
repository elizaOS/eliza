import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelType } from "@elizaos/core";
import { updateRoutingPreferences } from "@elizaos/plugin-native-inference/model-catalog/routing-preferences";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, test, vi } from "vitest";
import {
  installRouterHandler,
  ROUTER_PROVIDER,
} from "../../../../plugins/plugin-local-inference/src/services/router-handler.ts";
import { openaiPlugin } from "../../../../plugins/plugin-openai/index.ts";
import { applyNativeDirectRuntimeProfile } from "./native-runtime-profile.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test.each([false, true])(
  "direct native routing selects the registered compatible provider without fallback (failure=%s)",
  async (fail) => {
    const root = mkdtempSync(path.join(tmpdir(), "native-direct-routing-"));
    roots.push(root);
    vi.stubEnv("ELIZA_STATE_DIR", root);
    await applyNativeDirectRuntimeProfile(
      {
        ELIZA_RUNTIME_PROFILE: "native",
        ELIZA_PROVIDER: "cerebras",
        CEREBRAS_API_KEY: "fixture-inference-key",
        CEREBRAS_SMALL_MODEL: "qwen-3.8-27b",
        CEREBRAS_LARGE_MODEL: "qwen-3.8-27b",
        ELIZAOS_CLOUD_USE_INFERENCE: "false",
      },
      {
        loadConfig: () => ({}),
        saveConfig: () => {},
        updateRoutingPreferences,
      },
    );
    const runtime = createSQLiteTestRuntime({
      character: {
        name: "NativeDirectRouting",
        bio: "Routing fixture",
        settings: {},
      },
      logLevel: "fatal",
    });
    const failure = Object.assign(new Error("provider rate limited"), {
      status: 429,
    });
    const compatible = vi.fn(async () => {
      if (fail) throw failure;
      return "Selected direct provider";
    });
    const other = vi.fn(async () => "Another paid provider");
    for (const model of [ModelType.TEXT_SMALL, ModelType.TEXT_LARGE]) {
      runtime.registerModel(model, compatible, openaiPlugin.name, 0);
      runtime.registerModel(model, other, "other-paid-provider", 100);
    }
    installRouterHandler(runtime);
    try {
      for (const model of [ModelType.TEXT_SMALL, ModelType.TEXT_LARGE]) {
        const router = runtime.models
          .get(model)
          ?.find((entry) => entry.provider === ROUTER_PROVIDER);
        if (!router) throw new Error("Native router was not registered");
        const result = router.handler(runtime, {
          prompt: "Use the selected provider",
          stream: false,
        });
        if (fail) await expect(result).rejects.toBe(failure);
        else await expect(result).resolves.toBe("Selected direct provider");
      }
      expect(compatible).toHaveBeenCalledTimes(2);
      expect(other).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
    }
  },
);
