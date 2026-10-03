import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const load = (name) =>
  parse(readFileSync(resolve(root, ".github/workflows", name), "utf8"));

test("OS CI and USB releases require the same disposable raw-writer qualification", () => {
  const os = load("os.yml");
  const release = load("release-usb-installer.yml");
  const qualification = load("os-usb-raw-qualification.yml");
  assert.equal(
    os.jobs["linux-usb-virtual-block"].uses,
    "./.github/workflows/os-usb-raw-qualification.yml",
  );
  assert.equal(
    release.jobs["raw-writer-qualification"].uses,
    os.jobs["linux-usb-virtual-block"].uses,
  );
  assert.equal(release.jobs.build.needs, "raw-writer-qualification");
  assert.deepEqual(
    qualification.jobs.qualify.strategy.matrix["sector-size"],
    [512, 4096],
  );
  const run = qualification.jobs.qualify.steps
    .map((step) => step.run ?? "")
    .join("\n");
  assert.match(run, /qualify-raw-writer-vm\.py/);
  assert.match(run, /qualify-raw-pipeline\.ts/);
  assert.match(run, /--sector-size "\$SECTOR_BYTES"/);
});

test("literal USB release package commands resolve to current package scripts", () => {
  for (const name of [
    "release-usb-installer.yml",
    "os-usb-raw-qualification.yml",
  ]) {
    const workflow = load(name);
    const cwd = resolve(root, workflow.defaults.run["working-directory"]);
    assert.ok(existsSync(cwd));
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        for (const match of (step.run ?? "").matchAll(
          /bun run --cwd ([\w/-]+) ([\w:-]+)(?![\w:-])/g,
        )) {
          if (match[2].endsWith(":")) continue; // Matrix package target is checked below.
          const manifest = JSON.parse(
            readFileSync(resolve(cwd, match[1], "package.json"), "utf8"),
          );
          assert.equal(
            typeof manifest.scripts[match[2]],
            "string",
            `${name}: missing ${match[2]}`,
          );
        }
      }
    }
  }
  const scripts = JSON.parse(
    readFileSync(
      resolve(root, "packages/os/usb-installer/package.json"),
      "utf8",
    ),
  ).scripts;
  for (const platform of ["linux", "darwin", "win32"])
    assert.equal(typeof scripts[`package:${platform}`], "string");
});

test("Linux release evidence requires qualification of the writer extracted from the final package", () => {
  const steps = load("release-usb-installer.yml").jobs.build.steps;
  const extraction = steps.findIndex(
    (step) => step.name === "Verify Linux package boundary",
  );
  const qualification = steps.findIndex(
    (step) =>
      step.name === "Qualify the packaged Linux writer on disposable VM disks",
  );
  const binding = steps.findIndex(
    (step) => step.name === "Bind USB installer evidence to exact output bytes",
  );
  assert.ok(
    extraction >= 0 && qualification > extraction && binding > qualification,
  );
  for (const index of [extraction, qualification]) {
    assert.equal(steps[index].if, "matrix.platform == 'linux'");
    assert.notEqual(steps[index]["continue-on-error"], true);
  }
  assert.equal(steps[binding].if, undefined);
  assert.match(
    steps[extraction].run,
    /verify-electrobun-linux-package\.sh "\$payload" "\$RUNNER_TEMP\/packaged-linux-raw-writer"/,
  );
  assert.match(steps[qualification].run, /set -euo pipefail/);
  assert.match(steps[qualification].run, /for sector in 512 4096/);
  assert.match(
    steps[qualification].run,
    /--packaged-helper "\$RUNNER_TEMP\/packaged-linux-raw-writer"/,
  );
  assert.match(steps[qualification].run, /--sector-size "\$sector"/);
});

test("canonical OS CI retains legacy wrapper and browser checks without obsolete package commands", () => {
  const workflow = load("os.yml");
  const windows = workflow.jobs["android-powershell-safety"];
  assert.equal(windows["runs-on"], "windows-latest");
  assert.ok(
    windows.steps.some(
      (step) =>
        step.shell === "pwsh" &&
        step.run === "android/installer/tests/wrapper-safety.ps1",
    ),
  );
  const browser = workflow.jobs["usb-browser"];
  assert.notEqual(browser["continue-on-error"], true);
  assert.ok(
    browser.steps.some(
      (step) =>
        step["working-directory"] === "." &&
        step.run === "bun install --frozen-lockfile --ignore-scripts",
    ),
  );
  assert.ok(
    browser.steps.some((step) =>
      step.run?.includes("bun run --cwd usb-installer test:e2e"),
    ),
  );
  assert.ok(
    browser.steps.some(
      (step) =>
        step.with?.path === "test-results/os-usb-installer/" &&
        step.if === "always()",
    ),
  );
  const commands = Object.values(workflow.jobs)
    .flatMap((job) => (job.steps ?? []).map((step) => step.run ?? ""))
    .join("\n");
  assert.match(commands, /android\/installer\/tests\/run-tests\.sh/);
  for (const match of commands.matchAll(
    /\b(?:node|bash) ([\w/-]+\.(?:mjs|sh))/g,
  ))
    assert.ok(existsSync(resolve(root, "packages/os", match[1])), match[1]);
  assert.match(commands, /assert-canonical-linux-release\.ts/);
  assert.match(commands, /testOutputPath\("os-release-plan"\)/);
  assert.doesNotMatch(
    commands,
    /test:linux-virtual-usb|--cwd homepage|elizaos\/scripts\/mkosi-lint/,
  );
  assert.equal(
    existsSync(
      resolve(root, "packages/os/.github/workflows/elizaos-os-release.yml"),
    ),
    false,
  );
});
