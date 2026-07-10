// Pins the Windows CI sharding contract (#12338): grouped matrix lanes may
// change names or ordering deliberately, but they must keep every command the
// Windows compatibility lane is responsible for running.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowText = readFileSync(
  new URL("../../../.github/workflows/windows-ci.yml", import.meta.url),
  "utf8",
);

const EXPECTED_LANES = [
  "core-runtime",
  "app-and-cli",
  "framework-packages",
  "plugins",
  "build-and-helper-smokes",
];

const EXPECTED_COMMANDS = [
  "node packages/scripts/run-turbo.mjs run typecheck --filter=@elizaos/core --filter=@elizaos/shared --filter=@elizaos/cloud-shared --concurrency=4",
  "bun run --cwd packages/core test",
  "bun run --cwd packages/shared test",
  "bun run --cwd packages/app-core test",
  "bun run --cwd packages/elizaos test",
  // #15785: the tenant-db placement-claimer suite panics intermittently under
  // Bun canary/PGlite on Windows, so the whole-package run skips it and a
  // dedicated retry-isolated step (asserted below) re-runs it with a bounded
  // retry. The exclusion is only sound while that step exists.
  'bun run --cwd packages/cloud/shared test --path-ignore-patterns "**/tenant-db-placement-claimer.test.ts"',
  "bun run --cwd packages/scenario-runner test",
  "bun run --cwd packages/vault test",
  "bun run --cwd packages/security test",
  "bun run --cwd plugins/plugin-coding-tools test",
  "bun run --cwd plugins/plugin-elizacloud test",
  "bun run --cwd plugins/plugin-discord test",
  "bun run --cwd plugins/plugin-anthropic test",
  "bun run --cwd plugins/plugin-openai test",
  "bun run --cwd plugins/plugin-app-control test",
  "bun run --cwd plugins/plugin-task-coordinator test",
  "bun run --cwd plugins/plugin-browser test",
  "node packages/scripts/run-turbo.mjs run build --filter=@elizaos/core --filter=@elizaos/shared --filter=@elizaos/agent --concurrency=4",
  "node packages/scripts/run-bash-linux-only.mjs scripts/verify-riscv64-buildpaths.sh",
  "node packages/scripts/run-python.mjs --version",
  "node packages/scripts/test-cloud-run.mjs",
  "node packages/scripts/clean-stray-dts.mjs",
];

function extractMatrixLanes(): string[] {
  return [...workflowText.matchAll(/^ {10}- lane: (.+)$/gm)].map(
    (match) => match[1],
  );
}

function extractMatrixCommands(): string[] {
  return [...workflowText.matchAll(/^ {14}- (.+)$/gm)].map((match) => match[1]);
}

describe("Windows CI workflow", () => {
  test("keeps the shard lane set intentional", () => {
    expect(extractMatrixLanes()).toEqual(EXPECTED_LANES);
  });

  test("keeps every pre-shard command represented exactly once", () => {
    const commands = extractMatrixCommands();

    expect(commands).toHaveLength(EXPECTED_COMMANDS.length);
    expect(commands).toEqual(EXPECTED_COMMANDS);
    expect(new Set(commands).size).toBe(commands.length);
  });

  test("still runs the tenant-db suite the whole-package run excludes", () => {
    // Skipping a suite in the matrix without the isolated retry step would be
    // silent coverage loss, not flake mitigation. Pin the step's own block —
    // not the whole workflow — so repointing $suite at a different suite or
    // moving the step off the lane that runs packages/cloud/shared cannot
    // silently drop tenant-db coverage while these substrings survive elsewhere.
    const stepName =
      "Retry-isolated tenant-db PGlite suite (Windows canary flake, #15785)";
    const stepStart = workflowText.indexOf(stepName);
    expect(stepStart).toBeGreaterThan(-1);
    const nextStep = workflowText.indexOf("- name:", stepStart);
    const stepBlock = workflowText.slice(
      stepStart,
      nextStep === -1 ? undefined : nextStep,
    );
    expect(stepBlock).toContain("if: matrix.lane == 'app-and-cli'");
    expect(stepBlock).toContain(
      '$suite = "src/lib/services/tenant-db/tenant-db-placement-claimer.test.ts"',
    );
    expect(stepBlock).toContain(
      "bun run --cwd packages/cloud/shared test $suite",
    );
  });
});
