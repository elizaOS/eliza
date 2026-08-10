/**
 * Native face-pipeline lifecycle tests using deterministic backend doubles.
 */

import { describe, expect, it, vi } from "vitest";
import { FaceRecognition } from "./face-recognition-ggml";

function installBackends(
  pipeline: FaceRecognition,
  options: { embedderFails?: boolean } = {},
) {
  const detector = {
    initialize: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  const embedder = {
    initialize: options.embedderFails
      ? vi.fn(async () => {
          throw new Error("embedder unavailable");
        })
      : vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  Reflect.set(pipeline, "detector", detector);
  Reflect.set(pipeline, "embedder", embedder);
  return { detector, embedder };
}

describe("FaceRecognition readiness", () => {
  it("becomes ready only after detector and embedder initialize", async () => {
    const pipeline = new FaceRecognition();
    const { detector, embedder } = installBackends(pipeline);

    expect(pipeline.isInitialized()).toBe(false);
    await pipeline.initialize();

    expect(detector.initialize).toHaveBeenCalledOnce();
    expect(embedder.initialize).toHaveBeenCalledOnce();
    expect(pipeline.isInitialized()).toBe(true);
  });

  it("disposes partial native state and stays unavailable when initialization fails", async () => {
    const pipeline = new FaceRecognition();
    const { detector, embedder } = installBackends(pipeline, {
      embedderFails: true,
    });

    await expect(pipeline.initialize()).rejects.toThrow("embedder unavailable");

    expect(detector.dispose).toHaveBeenCalledOnce();
    expect(embedder.dispose).toHaveBeenCalledOnce();
    expect(pipeline.isInitialized()).toBe(false);
  });
});
