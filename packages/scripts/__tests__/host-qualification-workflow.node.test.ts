import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { validateHetznerFleetRouting } from "../hetzner-fleet-routing-contract.ts";

const workflows = fileURLToPath(
  new URL("../../../.github/workflows/", import.meta.url),
);
const QUALIFICATION = "cloud-existing-runner-qualification.yml";

/**
 * The manual host-qualification workflow pins the canary host on purpose: it
 * observes one existing machine with no checkout and no credentials, so a
 * hosted fallback would make it meaningless. The contract admits exactly that
 * job, with its human-dispatch guard, and nothing broader.
 */
test("host qualification keeps its canary pin only with its exact guard", () => {
  const root = mkdtempSync(path.join(tmpdir(), "host-qualification-routing-"));
  const directory = path.join(root, ".github/workflows");
  mkdirSync(directory, { recursive: true });
  // One canonical fleet selector so the contract has something to count.
  copyFileSync(
    path.join(workflows, "build-debian-package.yml"),
    path.join(directory, "build-debian-package.yml"),
  );
  const original = readFileSync(path.join(workflows, QUALIFICATION), "utf8");
  const check = (mutate, name = QUALIFICATION) => {
    const workflow = parse(original);
    mutate(workflow.jobs["qualify-existing-host"], workflow);
    const target = path.join(directory, name);
    writeFileSync(target, stringify(workflow));
    try {
      return validateHetznerFleetRouting(root);
    } finally {
      rmSync(target);
    }
  };
  try {
    assert.doesNotThrow(() => check(() => {}));
    for (const mutate of [
      (job) => {
        delete job.if;
      },
      (job) => {
        job.if = "github.event_name == 'workflow_dispatch'";
      },
      (job) => {
        delete job.environment;
      },
      (job) => {
        job["runs-on"][3] = "hetzner-robot";
      },
      (job) => {
        job["runs-on"] = ["self-hosted", "Linux", "X64", "x-canary", "gpu"];
      },
      (_job, workflow) => {
        workflow.on = { push: { branches: ["main"] } };
      },
    ])
      assert.throws(
        () => check(mutate),
        /explicit HETZNER_FLEET_ONLINE opt-in/,
      );
    assert.throws(
      () => check(() => {}, "unrelated.yml"),
      /explicit HETZNER_FLEET_ONLINE opt-in/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
