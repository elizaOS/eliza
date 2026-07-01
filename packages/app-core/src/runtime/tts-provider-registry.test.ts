import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_TO_SPEECH_PROVIDER,
  isTextToSpeechProviderDisabled,
} from "./tts-provider-registry.js";

const appCoreRoot = resolve(import.meta.dirname, "../..");

describe("TTS provider registry", () => {
  const originalDisableFlag = process.env.ELIZA_DISABLE_EDGE_TTS;

  afterEach(() => {
    if (originalDisableFlag === undefined) {
      delete process.env.ELIZA_DISABLE_EDGE_TTS;
    } else {
      process.env.ELIZA_DISABLE_EDGE_TTS = originalDisableFlag;
    }
  });

  it("owns the default TTS plugin metadata", () => {
    expect(DEFAULT_TEXT_TO_SPEECH_PROVIDER).toMatchObject({
      pluginName: "@elizaos/plugin-edge-tts",
      pluginConfigKey: "edge-tts",
      providerName: "edge-tts",
      priority: 0,
    });
    expect(typeof DEFAULT_TEXT_TO_SPEECH_PROVIDER.loadHandler).toBe("function");
  });

  it("honors config and env disable controls through the provider config key", () => {
    expect(
      isTextToSpeechProviderDisabled({
        plugins: { entries: { "edge-tts": { enabled: false } } },
      }),
    ).toBe(true);

    process.env.ELIZA_DISABLE_EDGE_TTS = "yes";
    expect(isTextToSpeechProviderDisabled({})).toBe(true);
  });

  it("keeps runtime glue free of the default TTS package literal", () => {
    const elizaSource = readFileSync(
      resolve(appCoreRoot, "src/runtime/eliza.ts"),
      "utf8",
    );
    const ensureSource = readFileSync(
      resolve(appCoreRoot, "src/runtime/ensure-text-to-speech-handler.ts"),
      "utf8",
    );

    expect(elizaSource).not.toContain("@elizaos/plugin-edge-tts");
    expect(ensureSource).not.toContain("@elizaos/plugin-edge-tts");
  });

  it("keeps the default TTS package literal owned by the registry entry", () => {
    const registrySource = readFileSync(
      resolve(appCoreRoot, "src/runtime/tts-provider-registry.ts"),
      "utf8",
    );

    expect(registrySource).not.toContain("@elizaos/plugin-edge-tts");
    expect(registrySource).toContain(
      "@elizaos/registry/first-party/generated.json",
    );
  });
});
