/** Exercises stage default models behavior with deterministic app test fixtures. */
import { describe, expect, it } from "bun:test";
import path from "node:path";
import {
  DEFAULT_MODELS,
  resolveDefaultModelsAssetsDir,
} from "./stage-default-models.mjs";

describe("stage-default-models", () => {
  it("stages Android assets into the app Capacitor project", () => {
    expect(resolveDefaultModelsAssetsDir("/repo")).toBe(
      path.join(
        "/repo",
        "packages",
        "app",
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

// All AOSP callers share the current monorepo layout and explicit override contract.
describe("AOSP config location", () => {
  it("resolves the canonical app and an explicit alternate host", async () => {
    const { resolveAppConfigPath } = await import(
      "./lib/load-variant-config.ts"
    );
    expect(resolveAppConfigPath({ repoRoot: "/repo" })).toBe(
      path.join("/repo", "packages", "app", "app.config.ts"),
    );
    expect(
      resolveAppConfigPath({
        repoRoot: "/repo",
        flagValue: "/fork/app.config.ts",
      }),
    ).toBe(path.resolve("/fork/app.config.ts"));
  });
});
