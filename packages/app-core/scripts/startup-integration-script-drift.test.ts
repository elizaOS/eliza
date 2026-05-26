import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
) as {
  scripts?: Record<string, string>;
};
const appCoreScriptsRoot = path.join(
  repoRoot,
  "packages",
  "app-core",
  "scripts",
);

function expectScript(scriptName: string) {
  const command = packageJson.scripts?.[scriptName];
  expect(typeof command).toBe("string");
  return command ?? "";
}

function extractTestPaths(command: string) {
  return Array.from(
    command.matchAll(/eliza\/[\w./-]+\.(?:test|spec)\.ts[x]?/g),
    (match) => match[0],
  );
}

const selfControlScriptsExpected =
  typeof packageJson.scripts?.["test:selfcontrol:startup"] === "string" &&
  typeof packageJson.scripts?.["test:selfcontrol:e2e"] === "string";
const hasWorkflows = (paths: string[]) =>
  paths.every((p) => fs.existsSync(path.join(repoRoot, p)));

describe("startup integration script drift", () => {
  it("keeps desktop dev Electrobun packaging aligned with the orchestrated root", () => {
    const devPlatform = fs.readFileSync(
      path.join(appCoreScriptsRoot, "dev-platform.mjs"),
      "utf8",
    );

    expect(devPlatform).toContain("ELIZA_ELECTROBUN_REPO_ROOT: bundleRoot");
    expect(devPlatform).toMatch(
      /skipApi\s*\?\s*\{\s*ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT:\s*"1"\s*\}/,
    );
  });

  it("syncs shared public assets before desktop renderer staleness checks", () => {
    const devPlatform = fs.readFileSync(
      path.join(appCoreScriptsRoot, "dev-platform.mjs"),
      "utf8",
    );

    const syncIndex = devPlatform.indexOf("syncRendererPublicAssets();");
    const staleIndex = devPlatform.indexOf(
      "viteRendererBuildNeeded(appDir, bundleRoot)",
    );

    expect(devPlatform).toContain("sync-to-public.mjs");
    expect(devPlatform).toContain('"--background"');
    expect(devPlatform).toContain('"--background-videos"');
    expect(syncIndex).toBeGreaterThanOrEqual(0);
    expect(staleIndex).toBeGreaterThan(syncIndex);
  });

  it("keeps desktop API watch mode opt-in", () => {
    const devPlatform = fs.readFileSync(
      path.join(appCoreScriptsRoot, "dev-platform.mjs"),
      "utf8",
    );

    expect(devPlatform).toContain(
      'const apiWatchEnabled = envFlagEnabled("ELIZA_DESKTOP_API_WATCH");',
    );
    expect(devPlatform).toContain("set ELIZA_DESKTOP_API_WATCH=1 to enable");
    expect(devPlatform).not.toContain(
      'const apiWatchEnabled = !envFlagDisabled("ELIZA_DESKTOP_API_WATCH");',
    );
  });

  it.skipIf(!selfControlScriptsExpected)(
    "keeps the website blocker smoke scripts wired to real files",
    () => {
      const startupCommand = expectScript("test:selfcontrol:startup");
      const e2eCommand = expectScript("test:selfcontrol:e2e");

      expect(startupCommand).toContain(
        "eliza/plugins/plugin-lifeops/test/selfcontrol-chat.live.e2e.test.ts",
      );
      expect(startupCommand).toContain(
        "eliza/plugins/plugin-lifeops/test/selfcontrol-dev.live.e2e.test.ts",
      );
      expect(e2eCommand).toContain(
        "eliza/plugins/plugin-lifeops/test/selfcontrol-dev.live.e2e.test.ts",
      );
      expect(e2eCommand).toContain(
        "eliza/plugins/plugin-lifeops/test/selfcontrol-desktop.live.e2e.test.ts",
      );

      for (const relativePath of new Set([
        ...extractTestPaths(startupCommand),
        ...extractTestPaths(e2eCommand),
      ])) {
        expect(
          fs.existsSync(path.join(repoRoot, relativePath)),
          `expected ${relativePath} to exist`,
        ).toBe(true);
      }
    },
  );

  it.skipIf(
    !selfControlScriptsExpected ||
      !hasWorkflows([
        ".github/workflows/test.yml",
        ".github/workflows/nightly.yml",
      ]),
  )("keeps CI workflows calling the startup smoke guards", () => {
    const workflowExpectations = new Map([
      [
        ".github/workflows/test.yml",
        [
          "bun run test:selfcontrol:e2e",
          "bun run test:selfcontrol:startup",
          "bun run test:startup:contract",
        ],
      ],
      [".github/workflows/nightly.yml", ["bun run test:startup:contract"]],
    ]);

    for (const [workflowFile, requiredCommands] of workflowExpectations) {
      const workflowText = fs.readFileSync(
        path.join(repoRoot, workflowFile),
        "utf8",
      );
      for (const command of requiredCommands) {
        expect(workflowText).toContain(command);
      }
    }
  });
});
