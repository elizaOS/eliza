/**
 * Exercises the parsed Windows matrix source contract against isolated repository
 * trees and the committed workflow without executing Windows jobs.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { parseWindowsMatrix, runContract } = await import(
  new URL("../ci-windows-command-coverage-contract.mjs", import.meta.url).href
);

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function write(root: string, relativePath: string, contents = ""): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function writePackage(
  root: string,
  relativeDir: string,
  name: string,
  scripts: Record<string, string>,
): void {
  write(
    root,
    `${relativeDir}/package.json`,
    `${JSON.stringify({ name, private: true, scripts }, null, 2)}\n`,
  );
}

function windowsWorkflow(
  lanes: { lane: string; commands: string[] }[],
): string {
  const include =
    lanes.length === 0
      ? "          []"
      : lanes
          .map(
            ({ lane, commands }) =>
              `          - lane: ${lane}\n` +
              (commands.length === 0
                ? "            commands: []"
                : `            commands:\n${commands
                    .map((command) => `              - ${command}`)
                    .join("\n")}`),
          )
          .join("\n");
  return `name: Windows CI
on: [push]
jobs:
  windows:
    runs-on: windows-latest
    strategy:
      matrix:
        include:
${include}
    steps:
      - uses: actions/checkout@v7
`;
}

const CORE_LANE = {
  lane: "core-runtime",
  commands: [
    "node packages/scripts/run-turbo.mjs run typecheck --filter=@elizaos/core --concurrency=4",
    "bun run --cwd packages/core test",
  ],
};
const HELPER_LANE = {
  lane: "helper-smokes",
  commands: [
    "node packages/scripts/run-bash-linux-only.mjs scripts/verify.sh",
    "node packages/scripts/check.mjs",
  ],
};

function buildRepo(lanes: { lane: string; commands: string[] }[]): string {
  const root = mkdtempSync(join(tmpdir(), "windows-command-source-"));
  write(
    root,
    "package.json",
    `${JSON.stringify(
      {
        name: "synthetic-root",
        private: true,
        workspaces: ["packages/*"],
      },
      null,
      2,
    )}\n`,
  );
  write(root, ".github/workflows/windows-ci.yml", windowsWorkflow(lanes));
  writePackage(root, "packages/core", "@elizaos/core", {
    test: "bun test",
    typecheck: "tsc --noEmit",
  });
  write(root, "packages/scripts/run-turbo.mjs");
  write(root, "packages/scripts/run-bash-linux-only.mjs");
  write(root, "packages/scripts/check.mjs");
  write(root, "scripts/verify.sh");
  return root;
}

function withRepo(
  lanes: { lane: string; commands: string[] }[],
  callback: (root: string) => void,
): void {
  const root = buildRepo(lanes);
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("ci-windows-command-coverage-contract", () => {
  test("resolves every command from multiple non-empty lanes", () => {
    withRepo([CORE_LANE, HELPER_LANE], (root) => {
      expect(parseWindowsMatrix(root)).toEqual([CORE_LANE, HELPER_LANE]);
      const result = runContract(root);
      expect(result.laneCount).toBe(2);
      expect(result.commandCount).toBe(4);
      expect(result.resolved.every(({ sources }) => sources.length > 0)).toBe(
        true,
      );
    });
  });

  test("rejects a matrix with no lanes", () => {
    withRepo([], (root) => {
      expect(() => runContract(root)).toThrow(/at least one lane/);
    });
  });

  test("rejects an empty lane", () => {
    withRepo([{ lane: "empty", commands: [] }], (root) => {
      expect(() => runContract(root)).toThrow(
        /lane "empty" must execute at least one command/,
      );
    });
  });

  test("rejects duplicate lane identities", () => {
    withRepo([CORE_LANE, { ...HELPER_LANE, lane: "CORE-RUNTIME" }], (root) => {
      expect(() => runContract(root)).toThrow(/lane identities/);
    });
  });

  test("rejects commands duplicated across lanes", () => {
    withRepo(
      [
        CORE_LANE,
        { lane: "duplicate-command", commands: [CORE_LANE.commands[1]] },
      ],
      (root) => {
        expect(() => runContract(root)).toThrow(
          /command is duplicated in lanes/,
        );
      },
    );
  });

  test("rejects a stale package directory", () => {
    withRepo(
      [
        {
          lane: "stale-package",
          commands: ["bun run --cwd packages/ghost test"],
        },
      ],
      (root) => {
        expect(() => runContract(root)).toThrow(
          /does not resolve to a workspace package/,
        );
      },
    );
  });

  test("rejects a stale package script", () => {
    withRepo(
      [
        {
          lane: "stale-script",
          commands: ["bun run --cwd packages/core test:ghost"],
        },
      ],
      (root) => {
        expect(() => runContract(root)).toThrow(
          /has no executable "test:ghost" script/,
        );
      },
    );
  });

  test("rejects an unresolved Turbo package filter", () => {
    withRepo(
      [
        {
          lane: "stale-filter",
          commands: [
            "node packages/scripts/run-turbo.mjs run typecheck --filter=@elizaos/ghost",
          ],
        },
      ],
      (root) => {
        expect(() => runContract(root)).toThrow(
          /does not resolve to a workspace package/,
        );
      },
    );
  });

  test("rejects Turbo commands without exact filters", () => {
    withRepo(
      [
        {
          lane: "unfiltered-turbo",
          commands: ["node packages/scripts/run-turbo.mjs run typecheck"],
        },
      ],
      (root) => {
        expect(() => runContract(root)).toThrow(
          /must use exact package filters/,
        );
      },
    );
  });

  test("rejects a stale Node entrypoint", () => {
    withRepo(
      [
        {
          lane: "stale-entrypoint",
          commands: ["node packages/scripts/ghost.mjs"],
        },
      ],
      (root) => {
        expect(() => runContract(root)).toThrow(
          /Node entrypoint does not resolve/,
        );
      },
    );
  });

  test("rejects a stale wrapped shell script", () => {
    withRepo(
      [
        {
          lane: "stale-wrapper-target",
          commands: [
            "node packages/scripts/run-bash-linux-only.mjs scripts/ghost.sh",
          ],
        },
      ],
      (root) => {
        expect(() => runContract(root)).toThrow(
          /wrapped script does not resolve/,
        );
      },
    );
  });

  test("rejects compound and unsupported command shapes", () => {
    withRepo(
      [
        {
          lane: "compound",
          commands: ["node packages/scripts/check.mjs && echo ok"],
        },
      ],
      (root) => {
        expect(() => runContract(root)).toThrow(/compound shell syntax/);
      },
    );
    withRepo(
      [{ lane: "unsupported", commands: ["echo not-source-resolved"] }],
      (root) => {
        expect(() => runContract(root)).toThrow(/unsupported command shape/);
      },
    );
  });

  test("rejects YAML aliases instead of expanding hidden matrix entries", () => {
    withRepo([CORE_LANE], (root) => {
      write(
        root,
        ".github/workflows/windows-ci.yml",
        `name: Windows CI
jobs:
  windows:
    strategy:
      matrix:
        include:
          - &lane
            lane: core
            commands:
              - bun run --cwd packages/core test
          - *lane
`,
      );
      expect(() => runContract(root)).toThrow(/YAML aliases are not allowed/);
    });
  });

  test("the committed matrix resolves every command to live source", () => {
    const result = runContract(REAL_REPO_ROOT);
    expect(result.resolved).toHaveLength(result.commandCount);
    expect(result.resolved.every(({ sources }) => sources.length > 0)).toBe(
      true,
    );
  });
});
