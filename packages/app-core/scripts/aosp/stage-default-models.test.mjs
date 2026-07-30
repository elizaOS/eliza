/** Exercises stage default models behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "bun:test";
import path from "node:path";
import {
  DEFAULT_MODELS,
  resolveDefaultModelsAssetsDir,
} from "./stage-default-models.mjs";

describe("stage-default-models", () => {
  it("stages Android assets into the app-core Capacitor project", () => {
    expect(resolveDefaultModelsAssetsDir("/repo")).toBe(
      path.join(
        "/repo",
        "packages",
        "app-core",
        "platforms",
        "android",
        "app",
        "src",
        "main",
        "assets",
        "agent",
        "models",
      ),
    );
  });

  it("uses the published architecture-slug bundle paths from the shared catalog", () => {
    expect(DEFAULT_MODELS[0]).toMatchObject({
      id: "eliza-1-2b",
      hfPath: "bundles/e2b/text/eliza-1-e2b-128k.gguf",
      ggufFile: "text/eliza-1-e2b-128k.gguf",
    });
    expect(DEFAULT_MODELS[1]).toMatchObject({
      hfPath: "bundles/e2b/tts/kokoro/kokoro-82m-v1_0.gguf",
      ggufFile: "tts/kokoro/kokoro-82m-v1_0.gguf",
    });
  });
});
