import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function extractStringArray(source: string, exportName: string): string[] {
  const match = source.match(
    new RegExp(`export const ${exportName}:[^=]+=\\s*\\[([\\s\\S]*?)\\];`, "m"),
  );
  if (!match) throw new Error(`Could not find ${exportName}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function extractProviderKinds(source: string): string[] {
  const match = source.match(
    /export type MobileSafeRuntimeProviderKind\s*=([\s\S]*?);/m,
  );
  if (!match) throw new Error("Could not find MobileSafeRuntimeProviderKind");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

describe("platform policy docs", () => {
  it("keeps the mobile plan aligned with mobile-safe runtime providers", () => {
    const plan = readRepoFile("docs/mobile-agentic-ide-platform-plan.md");
    const source = readRepoFile(
      "packages/app-core/src/runtime/mobile-safe-runtime.ts",
    );

    for (const provider of extractProviderKinds(source)) {
      expect(plan, `missing provider ${provider}`).toContain(provider);
    }

    for (const todo of [
      "TODO-AOSP-PTY",
      "TODO-AOSP-TOOLCHAIN",
      "TODO-AVF-PAYLOAD",
      "TODO-STORE-MOBILE-NATIVE-BRIDGES",
      "TODO-VFS-UI",
      "TODO-CLOUD-RUNTIME-UX",
      "TODO-REVIEW-NOTES",
    ]) {
      expect(plan, `missing implementation TODO ${todo}`).toContain(todo);
    }
  });

  it("keeps AOSP terminal plugin docs aligned with source constants", () => {
    const plan = readRepoFile("docs/mobile-agentic-ide-platform-plan.md");
    const source = readRepoFile("packages/agent/src/runtime/core-plugins.ts");

    for (const plugin of extractStringArray(
      source,
      "ELIZAOS_ANDROID_TERMINAL_PLUGINS",
    )) {
      expect(plan, `missing AOSP terminal plugin ${plugin}`).toContain(plugin);
    }
  });

  it("documents desktop store gating and Android cloud stripping", () => {
    const desktopDoc = readRepoFile("docs/desktop/build-variants.md");
    const mobileDoc = readRepoFile("packages/docs/apps/mobile.md");
    const sandboxDoc = readRepoFile("packages/docs/guides/sandbox.md");
    const buildScript = readRepoFile(
      "packages/app-core/scripts/run-mobile-build.mjs",
    );

    for (const text of [desktopDoc, sandboxDoc]) {
      expect(text).toContain("@elizaos/plugin-shell");
      expect(text).toContain("@elizaos/plugin-coding-tools");
      expect(text).toContain("agent-orchestrator");
    }

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
        `${desktopDoc}\n${mobileDoc}`,
        `docs missing Android cloud strip claim for ${stripped}`,
      ).toContain(stripped);
    }
    expect(buildScript).toContain("AndroidVirtualizationBridge.java");
  });
});
