import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..", "..");
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

describe("startup integration script drift", () => {
  it("keeps the website blocker smoke scripts wired to real files", () => {
    const startupCommand = expectScript("test:selfcontrol:startup");
    const e2eCommand = expectScript("test:selfcontrol:e2e");
    const desktopCommand = expectScript("test:live:selfcontrol:desktop");

    expect(startupCommand).toContain(
      "eliza/apps/app-lifeops/test/selfcontrol-chat.live.e2e.test.ts",
    );
    expect(startupCommand).toContain(
      "eliza/apps/app-lifeops/test/selfcontrol-dev.live.e2e.test.ts",
    );
    expect(e2eCommand).toContain(
      "eliza/apps/app-lifeops/test/selfcontrol-dev.live.e2e.test.ts",
    );
    expect(e2eCommand).not.toContain(
      "eliza/apps/app-lifeops/test/selfcontrol-desktop.live.e2e.test.ts",
    );
    expect(desktopCommand).toContain(
      "eliza/apps/app-lifeops/test/selfcontrol-desktop.live.e2e.test.ts",
    );

    for (const relativePath of new Set([
      ...extractTestPaths(startupCommand),
      ...extractTestPaths(e2eCommand),
      ...extractTestPaths(desktopCommand),
    ])) {
      expect(
        fs.existsSync(path.join(repoRoot, relativePath)),
        `expected ${relativePath} to exist`,
      ).toBe(true);
    }
  });

  it("keeps CI workflows calling the startup smoke guards", () => {
    const workflowExpectations = new Map([
      [
        ".github/workflows/test.yml",
        [
          "bun run test:selfcontrol:e2e",
          "bun run test:selfcontrol:startup",
          "bun run test:live:selfcontrol:desktop",
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
