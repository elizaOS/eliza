import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
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

const workflowPath = new URL(
  "../../../.github/workflows/build-debian-package.yml",
  import.meta.url,
);

test("canonical CI requires reusable OS verification and propagates failure", () => {
  const load = (name) =>
    parse(
      readFileSync(
        new URL(`../../../.github/workflows/${name}`, import.meta.url),
        "utf8",
      ),
    );
  const os = load("os.yml");
  const ci = load("ci.yml");
  const debian = load("build-debian-package.yml");
  assert.deepEqual(Object.keys(os.on).sort(), [
    "workflow_call",
    "workflow_dispatch",
  ]);
  assert.deepEqual(Object.keys(debian.on).sort(), [
    "workflow_call",
    "workflow_dispatch",
  ]);
  assert.equal(ci.jobs.os.uses, "./.github/workflows/os.yml");
  assert.ok(ci.jobs.required.needs.includes("os"));
  const aggregate = ci.jobs.required.steps.find((step) => step.env?.RESULTS);
  assert.match(aggregate.env.RESULTS, /os=\$\{\{ needs\.os\.result \}\}/);
  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const execute = () =>
      execFileSync("bash", ["-e", "-c", aggregate.run], {
        env: {
          ...process.env,
          RESULTS: `quality=success:true os=${result}:true`,
        },
        stdio: "pipe",
      });
    if (result === "success") assert.doesNotThrow(execute);
    else assert.throws(execute, (error) => error.status === 1);
  }
  for (const [results, passes] of [
    ["quality=success:true os=skipped:false", true],
    ["quality=success:true os=success:false", false],
    ["quality=success:true os=skipped", false],
    ["quality=success:true os=success:", false],
  ] as const) {
    const execute = () =>
      execFileSync("bash", ["-e", "-c", aggregate.run], {
        env: { ...process.env, RESULTS: results },
        stdio: "pipe",
      });
    if (passes) assert.doesNotThrow(execute);
    else assert.throws(execute, (error) => error.status === 1);
  }
  const sharedCheck = "bash scripts/linux/verify-debian-packaging.sh";
  for (const job of [
    os.jobs["debian-packaging-validation"],
    debian.jobs["validate-packaging"],
  ]) {
    assert.ok(job.steps.some((step) => step.run === sharedCheck));
  }
  const install = debian.jobs["build-deb"].steps.find(
    (step) => step.name === "Install deterministic Debian packaging tools",
  );
  assert.match(install.run, /\bpython3-cryptography\b/);
});

test("native Debian releases fail on hosted preflight when the fleet is unavailable", () => {
  const workflow = parse(readFileSync(workflowPath, "utf8"));
  const validation = workflow.jobs["validate-packaging"];
  const preflight = validation.steps[0];
  assert.equal(preflight["working-directory"], ".");
  assert.equal(validation["runs-on"], "ubuntu-24.04");
  assert.equal(preflight.if, "github.event_name != 'pull_request'");
  assert.equal(
    preflight.env.FLEET_ONLINE,
    "$" + "{{ vars.HETZNER_FLEET_ONLINE }}",
  );
  for (const value of [undefined, "", "false", "TRUE", "1", "true"]) {
    const env = { ...process.env };
    delete env.FLEET_ONLINE;
    if (value !== undefined) env.FLEET_ONLINE = value;
    const execute = () =>
      execFileSync("bash", ["-e", "-c", preflight.run], { env, stdio: "pipe" });
    if (value === "true") assert.doesNotThrow(execute);
    else
      assert.throws(
        execute,
        (error) => error.status === 1 && error.stdout.includes("::error::"),
      );
  }
});

test("native Debian fleet exception rejects missing guards and unrelated pools", () => {
  const root = mkdtempSync(path.join(tmpdir(), "os-debian-routing-"));
  const directory = path.join(root, ".github/workflows");
  mkdirSync(directory, { recursive: true });
  const original = readFileSync(workflowPath, "utf8");
  const check = (mutate, name = "build-debian-package.yml") => {
    const workflow = parse(original);
    mutate(workflow.jobs["build-deb"]);
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
        job.if = "github.event_name != 'pull_request'";
      },
      (job) => {
        job.if = "vars.HETZNER_FLEET_ONLINE == 'true'";
      },
      (job) => {
        delete job.needs;
      },
      (job) => {
        job["runs-on"][3] = "unrelated-pool";
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

for (const name of ["build-debian-package.yml", "build-linux-mkosi.yml"]) {
  test(`${name} rejects desktop artifacts from another source commit`, () => {
    const workflow = readFileSync(
      new URL(`../../../.github/workflows/${name}`, import.meta.url),
      "utf8",
    );
    const comparison = workflow
      .split("\n")
      .find((line) => line.trim().startsWith('test "$DESKTOP_SOURCE_SHA" ='));
    assert.ok(comparison, "release must compare the desktop source commit");
    const cwd = fileURLToPath(new URL("../../os/", import.meta.url));
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
    for (const source of [head, "0".repeat(40), ""]) {
      const run = () =>
        execFileSync("bash", ["-e", "-c", comparison], {
          cwd,
          env: { ...process.env, DESKTOP_SOURCE_SHA: source },
          stdio: "pipe",
        });
      if (source === head) assert.doesNotThrow(run);
      else assert.throws(run, (error) => error.status === 1);
    }
  });
}
