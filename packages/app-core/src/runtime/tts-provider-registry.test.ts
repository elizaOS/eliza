import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TEXT_TO_SPEECH_PROVIDER,
  isTextToSpeechProviderDisabled,
} from "./tts-provider-registry.js";

// ensure-text-to-speech-handler imports loadElizaConfig from the full agent
// runtime graph; stub it so the seam test stays hermetic (edge-tts is enabled
// by default → not disabled).
vi.mock("@elizaos/agent", () => ({ loadElizaConfig: () => ({}) }));

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

  it("owns the default TTS plugin metadata only (no importable handler)", () => {
    expect(DEFAULT_TEXT_TO_SPEECH_PROVIDER).toMatchObject({
      pluginName: "@elizaos/plugin-edge-tts",
      pluginConfigKey: "edge-tts",
      providerName: "edge-tts",
      priority: 0,
    });
    // The registry entry is metadata-only: it carries no handler-loading
    // function / importable module path (item 18, #12091). The concrete
    // handler comes from the loaded plugin's runtime registration; the default
    // fallback loader lives in tts-default-handler.ts.
    expect(
      (DEFAULT_TEXT_TO_SPEECH_PROVIDER as { loadHandler?: unknown })
        .loadHandler,
    ).toBeUndefined();
    expect(typeof DEFAULT_TEXT_TO_SPEECH_PROVIDER.wrapHandler).toBe("function");
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

  it("contains no variable-specifier import() (item 18 done-when)", () => {
    const registrySource = readFileSync(
      resolve(appCoreRoot, "src/runtime/tts-provider-registry.ts"),
      "utf8",
    );
    // The old code did `import(this.pluginName)` — a variable specifier that
    // bundlers cannot resolve. The registry must contain no dynamic import at
    // all now; provider selection flows through loaded-plugin registration.
    expect(registrySource).not.toMatch(/\bimport\s*\(/);
  });
});

describe("ensureTextToSpeechHandler", () => {
  it("uses the handler a loaded plugin already registered on the runtime", async () => {
    const { ensureTextToSpeechHandler } = await import(
      "./ensure-text-to-speech-handler.js"
    );

    const preRegistered = async () => new Uint8Array();
    let registered: unknown;
    const runtime = {
      getModel: (_modelType: unknown) => preRegistered,
      registerModel: (_modelType: unknown, handler: unknown) => {
        registered = handler;
      },
    };

    // A plugin already self-registered TEXT_TO_SPEECH, so ensure must NOT
    // re-import the package or overwrite the registration.
    await ensureTextToSpeechHandler(
      runtime as unknown as Parameters<typeof ensureTextToSpeechHandler>[0],
    );

    expect(registered).toBeUndefined();
  });
});
