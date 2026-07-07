// @vitest-environment jsdom
//
// Single-flight semantics of the boot-path @elizaos/ui/voice loader
// (src/boot-voice-load.ts): one underlying import shared by every await site,
// and a chunk-load failure resolves null (warn) instead of rejecting — a voice
// chunk failure must never gate mounting the app. Real module under test with
// an injected importer (the dynamic-import boundary), no mocks of the loader.

import { afterEach, describe, expect, it, vi } from "vitest";

async function freshLoader() {
  vi.resetModules();
  const mod = await import("../src/boot-voice-load");
  return mod.startVoiceModuleLoad;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startVoiceModuleLoad", () => {
  it("starts the import once and shares the promise across await sites", async () => {
    const startVoiceModuleLoad = await freshLoader();
    const voiceModule = { installAecLoopHarness: () => {} };
    let resolveImport: (m: unknown) => void = () => {};
    const importer = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve;
        }),
    );

    // Kick-off site (main() before the storage-bridge await)…
    const first = startVoiceModuleLoad(
      importer as unknown as Parameters<typeof startVoiceModuleLoad>[0],
    );
    // …and the later consumption sites re-enter while the chunk is in flight.
    const second = startVoiceModuleLoad(
      importer as unknown as Parameters<typeof startVoiceModuleLoad>[0],
    );

    expect(importer).toHaveBeenCalledTimes(1);
    resolveImport(voiceModule);
    await expect(first).resolves.toBe(voiceModule);
    await expect(second).resolves.toBe(voiceModule);
  });

  it("resolves null (and warns) on a chunk load failure instead of rejecting", async () => {
    const startVoiceModuleLoad = await freshLoader();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const importer = vi.fn(() => Promise.reject(new Error("chunk 404")));

    const result = await startVoiceModuleLoad(
      importer as unknown as Parameters<typeof startVoiceModuleLoad>[0],
    );

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[boot] @elizaos/ui/voice chunk unavailable",
      expect.any(Error),
    );
    // The failure is latched, not retried per await site — same single-flight
    // promise, so no second import storm during one boot.
    await expect(
      startVoiceModuleLoad(
        importer as unknown as Parameters<typeof startVoiceModuleLoad>[0],
      ),
    ).resolves.toBeNull();
    expect(importer).toHaveBeenCalledTimes(1);
  });
});
