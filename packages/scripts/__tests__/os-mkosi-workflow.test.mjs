import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { validateHetznerFleetRouting } from "../hetzner-fleet-routing-contract.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const original = readFileSync(
  join(root, ".github/workflows/build-linux-mkosi.yml"),
  "utf8",
);
const load = () => parse(original);

test("native Linux fleet preflight runs before checkout and fails explicitly when unavailable", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mkosi-fleet-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workflow = load();
  const job = workflow.jobs["validate-fleet"];
  const step = job.steps[0];
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(step["working-directory"], ".");
  for (const value of ["", "false", "TRUE", "1", "true"]) {
    const run = () =>
      execFileSync("bash", ["-e", "-c", step.run], {
        cwd: directory,
        env: { ...process.env, FLEET_ONLINE: value },
        stdio: "pipe",
      });
    if (value === "true") assert.doesNotThrow(run);
    else
      assert.throws(
        run,
        (error) => error.status === 1 && error.stdout.includes("::error::"),
      );
  }
});

test("Linux image workflow retains all architecture and exact-byte promotion gates", () => {
  const workflow = load();
  assert.deepEqual(Object.keys(workflow.on).sort(), [
    "workflow_call",
    "workflow_dispatch",
  ]);
  assert.equal(workflow.defaults.run["working-directory"], "packages/os");
  assert.deepEqual(
    workflow.jobs["build-and-qemu"].strategy.matrix.include.map(
      (item) => item.architecture,
    ),
    ["x86_64", "arm64", "riscv64"],
  );
  assert.equal(workflow.jobs["sign-and-stage"].needs, "build-and-qemu");
  for (const id of ["build-and-qemu", "sign-and-stage"]) {
    const job = workflow.jobs[id];
    assert.equal(job.environment, "release");
    assert.equal(
      job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))
        .with["node-version"],
      "24.15.0",
    );
    const scripts = job.steps.map((step) => step.run ?? "").join("\n");
    assert.doesNotMatch(scripts, /\$\{\{ inputs\./);
    for (const match of scripts.matchAll(
      /\b(?:node|python3|sudo) (scripts\/[\w/.-]+\.(?:mjs|py|sh))/g,
    ))
      assert.ok(existsSync(resolve(root, "packages/os", match[1])), match[1]);
    assert.match(scripts, /verify-mkosi-promotion-evidence\.mjs/);
    assert.match(scripts, /--persistence-evidence/);
    assert.match(scripts, /--legacy-bios-evidence/);
  }
  const build = workflow.jobs["build-and-qemu"].steps
    .map((step) => step.run ?? "")
    .join("\n");
  assert.match(build, /mkosi-persistence-qualify\.py/);
  assert.match(build, /--disk-interface usb/);
  assert.doesNotMatch(build, /fw_payload\.bin|matrix\.firmware-mode/);
  for (const name of [
    "QEMU boot exact expanded disk as removable USB",
    "Prove virtual USB readback and two-boot persistence",
  ]) {
    const step = workflow.jobs["build-and-qemu"].steps.find(
      (item) => item.name === name,
    );
    assert.match(step.run, /--firmware-code .*\/CODE\.fd/);
    assert.match(step.run, /--firmware-vars .*\/VARS\.fd/);
  }
  assert.match(build, /verify-desktop-artifact\.py/);
  const signing = workflow.jobs["sign-and-stage"].steps
    .map((step) => step.run ?? "")
    .join("\n");
  assert.ok(
    signing.indexOf("verify-mkosi-promotion-evidence.mjs") <
      signing.indexOf("sign-image-release.mjs"),
  );
  assert.match(
    signing,
    /verify-image-release\.mjs[\s\S]*--require-private-root/,
  );
});

test("native Linux fleet exception rejects missing guards, dependencies and unrelated signing pools", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mkosi-routing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, ".github/workflows");
  mkdirSync(directory, { recursive: true });
  const check = (mutate) => {
    const workflow = load();
    mutate(workflow);
    writeFileSync(
      join(directory, "build-linux-mkosi.yml"),
      stringify(workflow),
    );
    return validateHetznerFleetRouting(root);
  };
  assert.doesNotThrow(() => check(() => {}));
  for (const id of ["build-and-qemu", "sign-and-stage"]) {
    for (const field of ["if", "needs", "environment"])
      assert.throws(
        () =>
          check((workflow) => {
            delete workflow.jobs[id][field];
          }),
        /explicit HETZNER_FLEET_ONLINE opt-in/,
      );
    assert.throws(
      () =>
        check((workflow) => {
          workflow.jobs[id]["runs-on"][3] = "unrelated";
        }),
      /explicit HETZNER_FLEET_ONLINE opt-in/,
    );
  }
});
