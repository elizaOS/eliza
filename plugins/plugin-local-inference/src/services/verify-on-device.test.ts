import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifyBundleOnDevice } from "./verify-on-device";

const engineMock = {
  load: vi.fn(async () => {}),
  generate: vi.fn(async () => "ok"),
  startVoice: vi.fn(() => {}),
  armVoice: vi.fn(async () => {}),
  synthesizeSpeech: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
  triggerBargeIn: vi.fn(() => {}),
  stopVoice: vi.fn(async () => {}),
  unload: vi.fn(async () => {}),
};

const manifestState: { voiceFiles: number } = { voiceFiles: 0 };

function verifier() {
  const deps = {
    engine: engineMock,
    readFile: vi.fn(async () => "{}"),
    parseManifest: () => ({
      files: {
        voice: Array.from({ length: manifestState.voiceFiles }, (_, i) => ({
          path: `tts/v${i}.gguf`,
          sha256: "x",
        })),
      },
    }),
  } as unknown as Parameters<typeof createVerifyBundleOnDevice>[0];
  return createVerifyBundleOnDevice(deps);
}

const ARGS = {
  modelId: "eliza-1-0_8b",
  bundleRoot: "/tmp/bundle",
  manifestPath: "/tmp/bundle/eliza-1.manifest.json",
  textGgufPath: "/tmp/bundle/text/eliza-1-0_8b.gguf",
};

afterEach(() => {
  vi.clearAllMocks();
  manifestState.voiceFiles = 0;
});

describe("verifyBundleOnDevice", () => {
  it("loads, runs a 1-token text gen, and unloads for a text-only bundle", async () => {
    manifestState.voiceFiles = 0;
    await verifier()(ARGS);
    expect(engineMock.load).toHaveBeenCalledWith(ARGS.textGgufPath);
    expect(engineMock.generate).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 1 }),
    );
    expect(engineMock.startVoice).not.toHaveBeenCalled();
    expect(engineMock.unload).toHaveBeenCalled();
  });

  it("also runs a 1-phrase voice gen + barge-in cancel when the bundle ships voice", async () => {
    manifestState.voiceFiles = 1;
    await verifier()(ARGS);
    expect(engineMock.startVoice).toHaveBeenCalledWith(
      expect.objectContaining({
        bundleRoot: ARGS.bundleRoot,
        useFfiBackend: true,
      }),
    );
    expect(engineMock.synthesizeSpeech).toHaveBeenCalled();
    expect(engineMock.triggerBargeIn).toHaveBeenCalled();
    expect(engineMock.stopVoice).toHaveBeenCalled();
    expect(engineMock.unload).toHaveBeenCalled();
  });

  it("rethrows verify failures and still unloads", async () => {
    manifestState.voiceFiles = 0;
    engineMock.generate.mockRejectedValueOnce(new Error("kernel missing"));
    await expect(verifier()(ARGS)).rejects.toThrow("kernel missing");
    expect(engineMock.unload).toHaveBeenCalled();
  });

  it("fails verify when voice synthesis yields no PCM", async () => {
    manifestState.voiceFiles = 1;
    engineMock.synthesizeSpeech.mockResolvedValueOnce(new Uint8Array(0));
    await expect(verifier()(ARGS)).rejects.toThrow(/no PCM bytes/);
    expect(engineMock.stopVoice).toHaveBeenCalled();
  });
});
