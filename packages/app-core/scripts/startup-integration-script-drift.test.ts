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
  it.skipIf(!selfControlScriptsExpected)(
    "keeps the website blocker smoke scripts wired to real files",
    () => {
      const startupCommand = expectScript("test:selfcontrol:startup");
      const e2eCommand = expectScript("test:selfcontrol:e2e");

      expect(startupCommand).toContain(
        "eliza/plugins/app-lifeops/test/selfcontrol-chat.live.e2e.test.ts",
      );
      expect(startupCommand).toContain(
        "eliza/plugins/app-lifeops/test/selfcontrol-dev.live.e2e.test.ts",
      );
      expect(e2eCommand).toContain(
        "eliza/plugins/app-lifeops/test/selfcontrol-dev.live.e2e.test.ts",
      );
      expect(e2eCommand).toContain(
        "eliza/plugins/app-lifeops/test/selfcontrol-desktop.live.e2e.test.ts",
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
