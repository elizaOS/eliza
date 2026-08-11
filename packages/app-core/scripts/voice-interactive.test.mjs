/** Exercises voice interactive behavior with deterministic app-core test fixtures. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindOneShotTerminalEvents,
  createOneShotTurnCompletion,
  decodeWavForPush,
  feedPcmAtCaptureCadence,
  resolveInstalledBundleRoot,
  shouldPrewarmAfterTurn,
} from "./voice-interactive.mjs";

const tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "voice-interactive-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("resolveInstalledBundleRoot", () => {
  const catalogEntry = {
    id: "eliza-1-2b",
    ggufFile: "text/eliza-1-2b-128k.gguf",
  };

  it("rejects placeholder bundle directories that do not contain the primary text GGUF", async () => {
    const modelsDir = await makeTempDir();
    await mkdir(path.join(modelsDir, "eliza-1-2b.bundle"), {
      recursive: true,
    });

    const resolved = resolveInstalledBundleRoot(catalogEntry, modelsDir);

    expect(resolved).toMatchObject({
      bundleRoot: null,
      reason: "missing-text-gguf",
      expectedPath: path.join(
        modelsDir,
        "eliza-1-2b.bundle",
        "text",
        "eliza-1-2b-128k.gguf",
      ),
    });
  });

  it("accepts a bundle only when the catalog primary text GGUF is present", async () => {
    const modelsDir = await makeTempDir();
    const bundleRoot = path.join(modelsDir, "eliza-1-2b.bundle");
    const textPath = path.join(bundleRoot, "text", "eliza-1-2b-128k.gguf");
    await mkdir(path.dirname(textPath), { recursive: true });
    await writeFile(textPath, "gguf placeholder");

    const resolved = resolveInstalledBundleRoot(catalogEntry, modelsDir);

    expect(resolved).toEqual({
      bundleRoot,
      textPath,
    });
  });
});

describe("shouldPrewarmAfterTurn", () => {
  it("keeps idle prewarming out of one-shot say and WAV proofs", () => {
    expect(shouldPrewarmAfterTurn({ say: "hello", wav: null })).toBe(false);
    expect(shouldPrewarmAfterTurn({ say: null, wav: "speech.wav" })).toBe(
      false,
    );
  });

  it("keeps idle prewarming enabled for sustained interactive voice", () => {
    expect(shouldPrewarmAfterTurn({ say: null, wav: null })).toBe(true);
  });
});

describe("one-shot WAV completion", () => {
  it("feeds the normalized float PCM returned by the WAV decoder without reinterpreting its bytes", () => {
    const pcm = Float32Array.from([-0.75, 0, 0.5]);
    const decoded = decodeWavForPush(new Uint8Array([1, 2, 3]), () => ({
      pcm,
      sampleRate: 16_000,
    }));

    expect(decoded).toEqual({ pcm, sampleRate: 16_000 });
    expect(decoded.pcm).toBe(pcm);
    expect(decoded.pcm).toHaveLength(3);
  });

  it("rejects a WAV decoder that violates the normalized-float contract", () => {
    expect(() =>
      decodeWavForPush(new Uint8Array([1]), () => ({
        pcm: new Int16Array([1]),
        sampleRate: 16_000,
      })),
    ).toThrow(/Float32Array PCM/);
  });

  it("replays PCM at source cadence before trailing silence", async () => {
    const pushed = [];
    const waits = [];
    const source = {
      frameSamples: 4,
      sampleRate: 8,
      push: (samples) => pushed.push([...samples]),
    };

    await feedPcmAtCaptureCadence(
      source,
      Float32Array.from([1, 2, 3, 4, 5]),
      4,
      async (durationMs) => waits.push(durationMs),
    );

    expect(pushed).toEqual([[1, 2, 3, 4], [5], [0, 0, 0, 0]]);
    expect(waits).toEqual([500, 500, 500]);
  });

  it("requires a real completed turn instead of a fixed sleep", async () => {
    const completed = createOneShotTurnCompletion(100);
    completed.complete();

    await expect(completed.promise).resolves.toBeUndefined();
  });

  it("fails when no turn completes", async () => {
    const missing = createOneShotTurnCompletion(1);

    await expect(missing.promise).rejects.toThrow(/No completed turn/);
  });

  it("fails immediately when end-of-turn classification suppresses the transcript", async () => {
    const completion = createOneShotTurnCompletion(100);
    const events = bindOneShotTerminalEvents({}, completion);

    events.onTurnSuppressed("hello there", {
      endOfTurnProbability: 0.2,
      nextSpeaker: "user",
      agentShouldSpeak: false,
      source: "fused-eot",
    });

    await expect(completion.promise).rejects.toThrow(
      /suppressed by end-of-turn classification/,
    );
  });
});
