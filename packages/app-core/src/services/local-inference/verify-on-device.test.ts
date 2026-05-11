import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

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

vi.mock("./engine", () => ({ localInferenceEngine: engineMock }));

const manifestState: { voiceFiles: number } = { voiceFiles: 0 };
vi.mock("./manifest", () => ({
  parseManifestOrThrow: () => ({
    files: {
      voice: Array.from({ length: manifestState.voiceFiles }, (_, i) => ({
        path: `tts/v${i}.gguf`,
        sha256: "x",
      })),
    },
  }),
}));

// Override only `readFile` on the default export; keep the rest of
// node:fs/promises real. Bun's `vi.mock` module mocks are process-global and
// not auto-restored between test files, so a bare `{ default: { readFile } }`
// here would strip mkdtemp/rm/mkdir from every later suite in the same run.
const realFsPromises = createRequire(import.meta.url)(
  "node:fs/promises",
) as typeof import("node:fs/promises");
vi.mock("node:fs/promises", () => ({
  ...realFsPromises,
  default: { ...realFsPromises, readFile: vi.fn(async () => "{}") },
}));

const ARGS = {
  modelId: "eliza-1-0_6b",
  bundleRoot: "/tmp/bundle",
  manifestPath: "/tmp/bundle/eliza-1.manifest.json",
  textGgufPath: "/tmp/bundle/text/eliza-1-0_6b.gguf",
};

afterEach(() => {
  vi.clearAllMocks();
  manifestState.voiceFiles = 0;
});

describe("verifyBundleOnDevice", () => {
  it("loads, runs a 1-token text gen, and unloads for a text-only bundle", async () => {
    manifestState.voiceFiles = 0;
    const { verifyBundleOnDevice } = await import("./verify-on-device");
    await verifyBundleOnDevice(ARGS);
    expect(engineMock.load).toHaveBeenCalledWith(ARGS.textGgufPath);
    expect(engineMock.generate).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 1 }),
    );
    expect(engineMock.startVoice).not.toHaveBeenCalled();
    expect(engineMock.unload).toHaveBeenCalled();
  });

  it("also runs a 1-phrase voice gen + barge-in cancel when the bundle ships voice", async () => {
    manifestState.voiceFiles = 1;
    const { verifyBundleOnDevice } = await import("./verify-on-device");
    await verifyBundleOnDevice(ARGS);
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
    const { verifyBundleOnDevice } = await import("./verify-on-device");
    await expect(verifyBundleOnDevice(ARGS)).rejects.toThrow("kernel missing");
    expect(engineMock.unload).toHaveBeenCalled();
  });

  it("fails verify when voice synthesis yields no PCM", async () => {
    manifestState.voiceFiles = 1;
    engineMock.synthesizeSpeech.mockResolvedValueOnce(new Uint8Array(0));
    const { verifyBundleOnDevice } = await import("./verify-on-device");
    await expect(verifyBundleOnDevice(ARGS)).rejects.toThrow(/no PCM bytes/);
    expect(engineMock.stopVoice).toHaveBeenCalled();
  });
});
