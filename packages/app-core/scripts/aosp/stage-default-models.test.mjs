/** Exercises stage default models behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "bun:test";
import path from "node:path";
import { resolveDefaultModelsAssetsDir } from "./stage-default-models.mjs";

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
});
