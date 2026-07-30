// Pins the Windows CI sharding contract (#12338): grouped matrix lanes may
// change names or ordering deliberately, but they must keep every command the
// Windows compatibility lane is responsible for running.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowText = readFileSync(
  new URL("../../../.github/workflows/windows-ci.yml", import.meta.url),
  "utf8",
);
const provisioningCompositeText = readFileSync(
  new URL(
    "../../cloud/shared/src/lib/services/provisioning-jobs-16639-lane.test.ts",
    import.meta.url,
  ),
  "utf8",
);
const scheduledBackupText = readFileSync(
  new URL(
    "../../cloud/shared/src/lib/services/provisioning-jobs-scheduled-backup-sentinel.test.ts",
    import.meta.url,
  ),
  "utf8",
);
const provisioningDdlText = readFileSync(
  new URL(
    "../../cloud/shared/src/lib/services/__tests__/tier-upgrade-pglite-schema.ts",
    import.meta.url,
  ),
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
  "bun run --cwd packages/core typecheck",
  "bun run --cwd packages/shared typecheck",
  "bun run --cwd packages/cloud/shared typecheck",
  "bun run --cwd packages/core test",
  "bun run --cwd packages/shared test",
  "bun run --cwd packages/app-core test",
  "bun run --cwd packages/elizaos test",
  "bun run --cwd packages/cloud/shared test",
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
  "pwsh -NoLogo -NoProfile -File packages/scripts/__tests__/windows-ci-command-runner.test.ps1",
  "bun run --cwd plugins/plugin-coding-tools build",
  "node packages/scripts/run-turbo.mjs run build --filter=@elizaos/core --filter=@elizaos/shared --filter=@elizaos/agent --concurrency=1",
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

  test("keeps typecheck failures attributable and Windows builds serial", () => {
    expect(workflowText).not.toContain(
      "run typecheck --filter=@elizaos/core --filter=@elizaos/shared --filter=@elizaos/cloud-shared",
    );
    expect(workflowText).not.toContain(
      "run build --filter=@elizaos/core --filter=@elizaos/shared --filter=@elizaos/agent --concurrency=4",
    );
    for (const command of [
      "bun run --cwd packages/core typecheck",
      "bun run --cwd packages/shared typecheck",
      "bun run --cwd packages/cloud/shared typecheck",
      "bun run --cwd plugins/plugin-coding-tools build",
      "node packages/scripts/run-turbo.mjs run build --filter=@elizaos/core --filter=@elizaos/shared --filter=@elizaos/agent --concurrency=1",
    ]) {
      expect(workflowText).toContain(command);
    }
  });

  test("routes every matrix command through the bounded native-crash runner", () => {
    expect(workflowText).toContain(
      'Import-Module "$PWD/packages/scripts/windows-ci-command-runner.psm1" -Force',
    );
    expect(workflowText).toContain(
      "$code = Invoke-WindowsCiCommand -Command $command",
    );
    expect(workflowText).toContain(
      'Write-Error -ErrorAction Continue "Command failed with exit code $code`: $command"',
    );
    expect(workflowText).not.toContain("Invoke-Expression $command");
  });

  test("delegates the Windows PGlite quarantine to the package runner", () => {
    expect(workflowText).not.toContain("--path-ignore-patterns");
    expect(workflowText).not.toContain("Retry-isolated tenant-db PGlite suite");
    expect(workflowText).not.toContain(
      "bun run --cwd packages/cloud/shared test $suite",
    );
  });

  test("keeps the 16639 composite on plain PGlite DDL", () => {
    expect(provisioningCompositeText).toContain(
      'import "./provisioning-jobs-scheduled-backup-sentinel.test.ts"',
    );
    expect(scheduledBackupText).toContain(
      'import { PROVISIONING_JOB_TEST_TABLES } from "./__tests__/tier-upgrade-pglite-schema"',
    );
    expect(scheduledBackupText).not.toContain("drizzle-kit/api");
    expect(scheduledBackupText).not.toContain("pushSchema");
    expect(provisioningDdlText).toContain(
      "export const PROVISIONING_JOB_TEST_TABLES",
    );
    expect(provisioningDdlText).toContain(
      '"lifecycle_execution_generation" uuid',
    );
    expect(provisioningDdlText).toContain('"execution_generation" uuid');
    expect(provisioningDdlText).toContain('"execution_quiesced_at" timestamp');
  });
});
