/**
 * Contract tests for the always-completing develop lint/format gate.
 * The gate must have its own concurrency group with cancel-in-progress:
 * false so that rapid develop pushes cannot supersede it — the entire
 * purpose of #18360.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowPath = join(
  repoRoot,
  ".github",
  "workflows",
  "develop-lint-gate.yml",
);

describe("develop-lint-gate.yml contract", () => {
  const source = readFileSync(workflowPath, "utf8");

  test("exists and is valid YAML", () => {
    expect(source.length).toBeGreaterThan(0);
    const workflow = Bun.YAML.parse(source) as Record<string, unknown>;
    expect(workflow).toBeTruthy();
  });

  test("fires only on push to develop", () => {
    const workflow = Bun.YAML.parse(source) as Record<string, unknown>;
    // YAML 1.1 parses the bare word `on:` as the boolean `true`.
    const trigger = (workflow.on ?? workflow.true) as
      | Record<string, unknown>
      | string
      | undefined;
    expect(trigger).toBeTruthy();
    if (typeof trigger === "string") {
      expect(trigger).toBe("push");
      return;
    }
    expect(trigger).toHaveProperty("push");
    const pushTrigger = (trigger as { push?: Record<string, unknown> }).push;
    expect(pushTrigger?.branches).toEqual(["develop"]);
  });

  test("has its own concurrency group with cancel-in-progress false", () => {
    const workflow = Bun.YAML.parse(source) as {
      concurrency?: {
        group?: string;
        "cancel-in-progress"?: boolean;
      };
    };
    expect(workflow.concurrency).toBeTruthy();
    expect(workflow.concurrency?.group).toBe("develop-lint-gate");
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  test("guarantees every push completes via queue: max", () => {
    // cancel-in-progress: false alone only protects the running job.
    // GitHub's default queue: single replaces an older pending run when a
    // newer push arrives — so the older pending run never executes.
    // queue: max allows up to 100 pending runs to queue sequentially,
    // guaranteeing every develop push completes. This is the core fix
    // for tokenmaxxor's CHANGES_REQUESTED finding.
    // Ref: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
    const workflow = Bun.YAML.parse(source) as {
      concurrency?: {
        queue?: string;
        "cancel-in-progress"?: boolean;
      };
    };
    expect(workflow.concurrency?.queue).toBe("max");
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    // queue: max and cancel-in-progress: true is not allowed by GitHub
    // Actions, so verify this combination is valid.
    expect(workflow.concurrency?.["cancel-in-progress"]).not.toBe(true);
  });

  test("runs biome format:check and lint:check", () => {
    expect(source).toContain("bun run format:check");
    expect(source).toContain("bun run lint:check");
  });

  test("uses a provisionable hosted runner", () => {
    const workflow = Bun.YAML.parse(source) as {
      jobs?: Record<string, { "runs-on"?: string }>;
    };
    const job = workflow.jobs?.["develop-lint"];
    expect(job?.["runs-on"]).toBe("ubuntu-24.04");
  });

  test("uses a lean workspace setup without postinstall or native deps", () => {
    const workflow = Bun.YAML.parse(source) as {
      jobs?: Record<
        string,
        {
          steps?: Array<{
            uses?: string;
            with?: Record<string, string>;
          }>;
        }
      >;
    };
    const setupStep = workflow.jobs?.["develop-lint"]?.steps?.find(
      (s) => s.uses === "./.github/actions/setup-bun-workspace",
    );
    expect(setupStep).toBeTruthy();
    const inputs = setupStep?.with;
    expect(inputs?.["install-native-deps"]).toBe("false");
    expect(inputs?.["setup-python"]).toBe("false");
    expect(inputs?.["install-protoc"]).toBe("false");
    expect(inputs?.["run-postinstall"]).toBe("false");
  });

  test("uses least-privilege permissions", () => {
    const workflow = Bun.YAML.parse(source) as {
      permissions?: { contents?: string };
    };
    expect(workflow.permissions?.contents).toBe("read");
  });
});
