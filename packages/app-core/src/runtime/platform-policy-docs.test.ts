import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("platform policy docs", () => {
  it("documents Android cloud stripping and store gating", () => {
    const mobileDoc = readRepoFile("packages/docs/apps/mobile.md");
    const sandboxDoc = readRepoFile("packages/docs/guides/sandbox.md");
    const buildScript = readRepoFile(
      "packages/app-core/scripts/run-mobile-build.mjs",
    );

    expect(sandboxDoc).toContain("@elizaos/plugin-shell");
    expect(sandboxDoc).toContain("@elizaos/plugin-coding-tools");
    expect(sandboxDoc).toContain("agent-orchestrator");

    expect(mobileDoc).toMatch(/do\s+not run a local Bun backend/);
    expect(mobileDoc).toContain("bun run build:android:cloud");
    expect(mobileDoc).toContain("bun run build:android:system");

    for (const stripped of [
      "ElizaAgentService",
      "MANAGE_APP_OPS_MODES",
      "PACKAGE_USAGE_STATS",
      "MANAGE_VIRTUAL_MACHINE",
      "assets/agent",
      "libeliza_",
    ]) {
      expect(
        buildScript,
        `build script no longer strips ${stripped}`,
      ).toContain(stripped);
      expect(
        mobileDoc,
        `mobile doc missing Android cloud strip claim for ${stripped}`,
      ).toContain(stripped);
    }
    expect(buildScript).toContain("AndroidVirtualizationBridge.java");
  });
});
