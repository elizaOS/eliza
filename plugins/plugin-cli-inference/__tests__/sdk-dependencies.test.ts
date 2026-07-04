/**
 * Static-source guard: every `SDK_PACKAGE` a session file lazily imports must be
 * declared as an `optionalDependency` in package.json (scans the source text; no
 * real SDK loaded), so the variable dynamic import can resolve when the backend
 * is enabled while the plugin stays inert otherwise.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

async function readSdkPackageConstants(): Promise<string[]> {
  const sdkSourceFiles = ["src/claude-sdk-session.ts", "src/codex-sdk-session.ts"];
  const sdkPackages = new Set<string>();

  for (const sourceFile of sdkSourceFiles) {
    const source = await readFile(path.join(pluginRoot, sourceFile), "utf8");
    for (const match of source.matchAll(/const\s+SDK_PACKAGE\s*=\s*"([^"]+)"/g)) {
      sdkPackages.add(match[1]);
    }
  }

  return [...sdkPackages].sort();
}

describe("SDK lazy-import package metadata", () => {
  it("declares every lazily imported SDK package as an optional dependency", async () => {
    const packageJson = await readJson(path.join(pluginRoot, "package.json"));
    const optionalDependencies = packageJson.optionalDependencies as
      | Record<string, string>
      | undefined;

    expect(optionalDependencies).toBeTruthy();
    expect(await readSdkPackageConstants()).toEqual([
      "@anthropic-ai/claude-agent-sdk",
      "@openai/codex-sdk",
    ]);
    for (const sdkPackage of await readSdkPackageConstants()) {
      expect(optionalDependencies).toHaveProperty(sdkPackage);
    }
  });
});
