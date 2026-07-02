import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitPluginToRegistry } from "./plugins.js";

let tempDirs: string[] = [];

function makePluginPackage(packageJson: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), "elizaos-plugin-submit-"));
  tempDirs.push(dir);
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("submitPluginToRegistry", () => {
  it("allows dry-run metadata generation without a configured registry", async () => {
    const dir = makePluginPackage({
      name: "@acme/plugin-weather",
      version: "1.0.0",
      description: "Weather tools for Eliza agents",
      keywords: ["elizaos", "plugin"],
      repository: {
        type: "git",
        url: "https://github.com/acme/plugin-weather.git",
      },
    });

    await expect(
      submitPluginToRegistry(dir, { base: "main", dryRun: true }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["git+ssh://git@github.com/acme/plugin-weather.git"],
    ["ssh://git@github.com/acme/plugin-weather.git"],
    ["git://github.com/acme/plugin-weather.git"],
  ])("normalizes the npm repository url form %s", async (repositoryUrl) => {
    const dir = makePluginPackage({
      name: "@acme/plugin-weather",
      version: "1.0.0",
      keywords: ["elizaos", "plugin"],
      repository: { type: "git", url: repositoryUrl },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await submitPluginToRegistry(dir, { base: "main", dryRun: true });
      const printed = logSpy.mock.calls.at(-1)?.[0];
      expect(typeof printed).toBe("string");
      const parsed = JSON.parse(printed as string) as {
        metadata: { repository: string };
      };
      expect(parsed.metadata.repository).toBe("github:acme/plugin-weather");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("rejects PR submission when no writable registry repository is configured", async () => {
    const dir = makePluginPackage({
      name: "@acme/plugin-weather",
      version: "1.0.0",
      keywords: ["elizaos", "plugin"],
      repository: "https://github.com/acme/plugin-weather",
    });

    await expect(
      submitPluginToRegistry(dir, {
        base: "main",
        skipValidation: true,
        yes: true,
      }),
    ).rejects.toThrow(/community registry lives in the elizaOS monorepo/);
  });

  it("rejects malformed explicit registry repositories", async () => {
    const dir = makePluginPackage({
      name: "@acme/plugin-weather",
      repository: "https://github.com/acme/plugin-weather",
    });

    await expect(
      submitPluginToRegistry(dir, {
        registry: "https://github.com/elizaos-plugins/registry",
        base: "main",
        dryRun: true,
      }),
    ).rejects.toThrow(/Invalid registry repository/);
  });
});
