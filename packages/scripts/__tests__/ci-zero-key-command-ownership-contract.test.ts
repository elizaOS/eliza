// Pins the zero-key command ownership contract (#13402) against synthetic
// workflow trees: unique commands pass, duplicate real suite commands fail,
// repeated setup stays allowed, and the shipped repo stays clean. Static only:
// no workflow is executed.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { collectZeroKeyCommands, findDuplicateOwnedCommands, runContract } =
  await import(
    new URL("../ci-zero-key-command-ownership-contract.mjs", import.meta.url)
      .href
  );

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function workflow({
  name,
  jobKey = "checks",
  jobName,
  commands,
}: {
  name: string;
  jobKey?: string;
  jobName: string;
  commands: string[];
}): string {
  return `name: ${name}
on: [pull_request]
jobs:
  ${jobKey}:
    name: ${jobName}
    runs-on: ubuntu-24.04
    steps:
      - name: Run
        run: |
${commands.map((command) => `          ${command}`).join("\n")}
`;
}

function buildRepo(overrides: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "zero-key-command-ownership-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  const defaults: Record<string, string> = {
    "test.yml": workflow({
      name: "Tests",
      jobName: "Zero-Key deterministic",
      commands: ["bun run test:server"],
    }),
    "scenario-pr.yml": workflow({
      name: "Scenario PR E2E",
      jobName: "Zero-Key scenario",
      commands: ["bun run --cwd packages/scenario-runner test"],
    }),
    "keyless-harness-e2e.yml": workflow({
      name: "Keyless harness",
      jobName: "Keyless harness",
      commands: [
        "bunx vitest run --config test/mocks/vitest.config.ts test/mocks/__tests__/",
      ],
    }),
    "ui-fixture-e2e.yml": workflow({
      name: "UI fixture",
      jobName: "Zero-Key UI fixture",
      commands: ["bun run --cwd packages/ui test:launcher-e2e"],
    }),
  };
  for (const [name, content] of Object.entries({ ...defaults, ...overrides })) {
    writeFileSync(join(root, ".github", "workflows", name), content);
  }
  return root;
}

function withRepo(
  overrides: Record<string, string>,
  fn: (root: string) => void,
) {
  const root = buildRepo(overrides);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("ci-zero-key-command-ownership-contract", () => {
  test("passes when every real zero-key command has one owner", () => {
    withRepo({}, (root) => {
      const result = runContract(root);
      expect(result.commandCount).toBe(4);
    });
  });

  test("fails when two workflows own the same real suite command", () => {
    withRepo(
      {
        "scenario-pr.yml": workflow({
          name: "Scenario PR E2E",
          jobName: "Zero-Key scenario",
          commands: ["bun run test:server"],
        }),
      },
      (root) => {
        expect(() => runContract(root)).toThrow(
          /Duplicate zero-key command ownership/,
        );
      },
    );
  });

  test("allows repeated setup commands while still collecting suite commands", () => {
    withRepo(
      {
        "test.yml": workflow({
          name: "Tests",
          jobName: "Zero-Key deterministic",
          commands: [
            "node packages/app-core/scripts/ensure-shared-i18n-data.mjs",
            "bun run test:server",
          ],
        }),
        "scenario-pr.yml": workflow({
          name: "Scenario PR E2E",
          jobName: "Zero-Key scenario",
          commands: [
            "node packages/app-core/scripts/ensure-shared-i18n-data.mjs",
            "bun run --cwd packages/scenario-runner test",
          ],
        }),
      },
      (root) => {
        const rows = collectZeroKeyCommands(root);
        expect(findDuplicateOwnedCommands(rows)).toEqual([]);
        expect(runContract(root).commandCount).toBe(6);
      },
    );
  });

  test("normalizes leading env assignments before ownership checks", () => {
    withRepo(
      {
        "scenario-pr.yml": workflow({
          name: "Scenario PR E2E",
          jobName: "Zero-Key scenario",
          commands: ["PLAYWRIGHT_WEBKIT=1 bun run test:server"],
        }),
      },
      (root) => {
        const rows = collectZeroKeyCommands(root);
        expect(rows).toContainEqual(
          expect.objectContaining({
            workflow: ".github/workflows/scenario-pr.yml",
            command: "bun run test:server",
          }),
        );
        expect(() => runContract(root)).toThrow(
          /Duplicate zero-key command ownership/,
        );
      },
    );
  });

  test("ignores static classifier and delegation jobs that mention the contract", () => {
    withRepo(
      {
        "test.yml": workflow({
          name: "Tests",
          jobKey: "changes",
          jobName: "Classify changed paths",
          commands: [
            "node packages/scripts/ci-zero-key-command-ownership-contract.mjs",
          ],
        }),
        "scenario-pr.yml": workflow({
          name: "Scenario PR E2E",
          jobKey: "app-diagnostics",
          jobName: "Zero-Key app diagnostics",
          commands: [
            "node packages/scripts/ci-zero-key-command-ownership-contract.mjs",
          ],
        }),
      },
      (root) => {
        const rows = collectZeroKeyCommands(root);
        expect(rows).not.toContainEqual(
          expect.objectContaining({
            command:
              "node packages/scripts/ci-zero-key-command-ownership-contract.mjs",
          }),
        );
        expect(runContract(root).commandCount).toBe(2);
      },
    );
  });

  test("collects commands from explicitly owned fixture workflows without job markers", () => {
    withRepo(
      {
        "ui-fixture-e2e.yml": workflow({
          name: "UI Fixture E2E",
          jobName: "Fixture e2e",
          commands: ["bun run test:server"],
        }),
      },
      (root) => {
        const rows = collectZeroKeyCommands(root);
        expect(rows).toContainEqual(
          expect.objectContaining({
            workflow: ".github/workflows/ui-fixture-e2e.yml",
            command: "bun run test:server",
          }),
        );
        expect(() => runContract(root)).toThrow(
          /Duplicate zero-key command ownership/,
        );
      },
    );
  });

  test("the real repo satisfies the zero-key ownership contract", () => {
    const result = runContract(REAL_REPO_ROOT);
    expect(result.commandCount).toBeGreaterThan(0);
  });
});
