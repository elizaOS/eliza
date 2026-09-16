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

  it("uses the published entry-tier chat and voice paths", () => {
    const chat = DEFAULT_MODELS.find((model) => model.role === "chat");
    const voice = DEFAULT_MODELS.find((model) => model.id === "eliza-1-kokoro");

    expect(chat?.hfPath).toBe("bundles/e2b/text/eliza-1-e2b-128k.gguf");
    expect(chat?.ggufFile).toBe("text/eliza-1-e2b-128k.gguf");
    expect(voice?.hfPath).toBe("bundles/e2b/tts/kokoro/kokoro-82m-v1_0.gguf");
    expect(voice?.ggufFile).toBe("tts/kokoro/kokoro-82m-v1_0.gguf");
  });
});
