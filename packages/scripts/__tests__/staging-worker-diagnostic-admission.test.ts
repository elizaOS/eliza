/** Executes the workflow's real pre-credential shell gate with valid and hostile diagnostic inputs. */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = Bun.YAML.parse(
  readFileSync(
    join(
      import.meta.dir,
      "../../../.github/workflows/deploy-eliza-provisioning-worker.yml",
    ),
    "utf8",
  ),
) as { jobs: Record<string, { steps: { id?: string; run?: string }[] }> };
const script = workflow.jobs["determine-env"].steps.find(
  (step) => step.id === "snapshot",
)?.run;
if (typeof script !== "string")
  throw new Error("Diagnostic admission script is unavailable");

function admit(mode: string, digest: string) {
  return spawnSync("/bin/bash", ["-s"], {
    input: script,
    encoding: "utf8",
    env: {
      PATH: "/no-external-commands",
      MODE: mode,
      EXPECTED_WORKER_SHA: "a".repeat(40),
      TARGET_CONTAINER_SHA256: digest,
      EFFECT_DIGEST: "",
      REQUESTED_SHA: "",
    },
  });
}

test("valid diagnostic admission exits without credentials or external commands", () => {
  for (const digest of ["", "b".repeat(64)]) {
    const result = admit("diagnose", digest);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  }
});

test("hostile or misplaced correlation input is rejected before any deployment work", () => {
  for (const [mode, digest] of [
    ["diagnose", "$(printf private-input)"],
    ["diagnose", "b".repeat(63)],
    ["deploy", "b".repeat(64)],
  ]) {
    const result = admit(mode, digest);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("private-input");
  }
});
