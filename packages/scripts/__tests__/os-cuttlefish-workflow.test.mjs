import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    new URL(
      "../../../.github/workflows/elizaos-cuttlefish.yml",
      import.meta.url,
    ),
    "utf8",
  ),
);
const job = workflow.jobs["build-and-validate"];

test("Cuttlefish runs from OS package paths with pinned Node and a gated native fleet", () => {
  assert.equal(workflow.defaults.run["working-directory"], "packages/os");
  assert.equal(job.needs, "validate-fleet");
  assert.equal(job.environment, "release");
  assert.equal(
    job.if,
    "github.event_name != 'pull_request' && vars.HETZNER_FLEET_ONLINE == 'true'",
  );
  assert.equal(
    job.steps.find((s) => s.uses?.startsWith("actions/setup-node@")).with[
      "node-version"
    ],
    "24.15.0",
  );
  const commands = job.steps
    .flatMap((s) => [s.run ?? "", s.with?.script ?? ""])
    .join("\n");
  assert.doesNotMatch(
    commands,
    /reports\/cuttlefish|\b(?:node|git -C) \.eliza-source/,
  );
  assert.match(commands, /testOutputPath\("os-cuttlefish"\)/);
  assert.doesNotMatch(commands, /\$\{\{ inputs\./);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
});

test("guest binding refuses physical devices before invoking boot validation", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cvd-guest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "adb"),
    '#!/bin/bash\ncase "$*" in *get-serialno*) echo localhost:6520 ;; *ro.product.device*) echo "$TEST_DEVICE" ;; *ro.build.type*) echo userdebug ;; *) exit 99 ;; esac\n',
  );
  writeFileSync(
    join(dir, "node"),
    '#!/bin/bash\nprintf "%s" "$ANDROID_SERIAL" > "$NODE_MARKER"\n',
  );
  for (const name of ["adb", "node"]) chmodSync(join(dir, name), 0o755);
  const step = job.steps.find(
    (s) => s.name === "Bind validation to the disposable Cuttlefish guest",
  );
  assert.equal(step.if, "success() && inputs.launch == true");
  const run = (device) =>
    execFileSync("bash", ["-c", step.run], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        TEST_DEVICE: device,
        BRAND_CONFIG: "brand.json",
        GITHUB_ENV: join(dir, "env"),
        NODE_MARKER: join(dir, "called"),
      },
      stdio: "pipe",
    });
  assert.throws(
    () => run("physical-phone"),
    (error) => error.status === 1,
  );
  assert.throws(() => readFileSync(join(dir, "called")), { code: "ENOENT" });
  run("vsoc_x86_64");
  assert.equal(readFileSync(join(dir, "called"), "utf8"), "localhost:6520");
  for (const name of [
    "Verify application-native kernels on Cuttlefish",
    "Prove full WAV to ASR to agent to TTS round trip",
    "Exercise privileged Android instrumentation on Cuttlefish",
    "Verify assistant role, IME, and assist-key routing",
  ]) {
    assert.equal(
      job.steps.find((s) => s.name === name).if,
      "success() && inputs.launch == true",
    );
  }
});
