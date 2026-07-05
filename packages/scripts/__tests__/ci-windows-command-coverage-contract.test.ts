/**
 * Pins the Windows command-coverage contract (#13402) against synthetic
 * workflow and inventory trees. Dropping an inventoried command from the matrix
 * throws (RED), keeping all present passes (GREEN), adding a new command is
 * allowed, and the shipped repo satisfies its own inventory. Static only: no
 * workflow is executed.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const {
  parseWindowsCommands,
  loadInventory,
  findDroppedCommands,
  runContract,
} = await import(
  new URL("../ci-windows-command-coverage-contract.mjs", import.meta.url).href
);

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// Two lanes with two commands each is enough to exercise both the multi-lane
// flatten and the per-lane list boundary. Indentation matches windows-ci.yml
// (include items at 10 spaces, command items at 14).
function windowsWorkflow(
  lanes: { lane: string; commands: string[] }[],
): string {
  const include = lanes
    .map(
      ({ lane, commands }) =>
        `          - lane: ${lane}\n` +
        `            commands:\n` +
        commands.map((command) => `              - ${command}`).join("\n"),
    )
    .join("\n");
  return `name: Windows CI
on: [push]
jobs:
  windows:
    runs-on: windows-latest
    strategy:
      fail-fast: false
      matrix:
        include:
${include}
    steps:
      - uses: actions/checkout@v4
`;
}

function buildRepo({
  lanes,
  inventory,
}: {
  lanes: { lane: string; commands: string[] }[];
  inventory: string[];
}): string {
  const root = mkdtempSync(join(tmpdir(), "windows-command-coverage-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github", "workflows", "windows-ci.yml"),
    windowsWorkflow(lanes),
  );
  writeFileSync(
    join(root, ".github", "ci-windows-command-inventory.json"),
    JSON.stringify({ commands: inventory }, null, 2),
  );
  return root;
}

function withRepo(
  config: {
    lanes: { lane: string; commands: string[] }[];
    inventory: string[];
  },
  fn: (root: string) => void,
) {
  const root = buildRepo(config);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const CORE_LANE = {
  lane: "core-runtime",
  commands: [
    "bun run --cwd packages/core test",
    "bun run --cwd packages/shared test",
  ],
};
const PLUGIN_LANE = {
  lane: "plugins",
  commands: ["bun run --cwd plugins/plugin-openai test"],
};
const FULL_INVENTORY = [...CORE_LANE.commands, ...PLUGIN_LANE.commands];

describe("ci-windows-command-coverage-contract", () => {
  test("GREEN: passes when every inventoried command is still wired in a lane", () => {
    withRepo(
      { lanes: [CORE_LANE, PLUGIN_LANE], inventory: FULL_INVENTORY },
      (root) => {
        const result = runContract(root);
        expect(result.commandCount).toBe(3);
        expect(result.inventoryCount).toBe(3);
      },
    );
  });

  test("RED: throws when an inventoried command is dropped from the matrix", () => {
    withRepo({ lanes: [CORE_LANE], inventory: FULL_INVENTORY }, (root) => {
      expect(() => runContract(root)).toThrow(
        /Windows CI command coverage shrank/,
      );
      expect(
        findDroppedCommands(FULL_INVENTORY, parseWindowsCommands(root)),
      ).toEqual(["bun run --cwd plugins/plugin-openai test"]);
    });
  });

  test("flattens commands across every include[] lane", () => {
    withRepo(
      { lanes: [CORE_LANE, PLUGIN_LANE], inventory: FULL_INVENTORY },
      (root) => {
        expect(parseWindowsCommands(root)).toEqual([
          "bun run --cwd packages/core test",
          "bun run --cwd packages/shared test",
          "bun run --cwd plugins/plugin-openai test",
        ]);
      },
    );
  });

  test("adding a command beyond the inventory is allowed (floor, not exact match)", () => {
    withRepo(
      {
        lanes: [
          CORE_LANE,
          { lane: "extra", commands: ["bun run --cwd packages/new test"] },
        ],
        inventory: CORE_LANE.commands,
      },
      (root) => {
        expect(runContract(root).commandCount).toBe(3);
      },
    );
  });

  test("rejects an empty inventory", () => {
    withRepo({ lanes: [CORE_LANE], inventory: [] }, (root) => {
      expect(() => loadInventory(root)).toThrow(/must not be empty/);
    });
  });

  test("the real repo satisfies its committed Windows command inventory", () => {
    const result = runContract(REAL_REPO_ROOT);
    expect(result.inventoryCount).toBeGreaterThan(0);
    expect(result.commandCount).toBeGreaterThanOrEqual(result.inventoryCount);
  });
});
