import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = parse(
  readFileSync(
    join(root, ".github/workflows/publish-aosp-update-manifest.yml"),
    "utf8",
  ),
);
const job = workflow.jobs["publish-manifest"];
const script = job.steps.find(
  (step) => step.name === "Validate signed Android releases and publish index",
).run;

test("AOSP index publication runs the monorepo verifier under the protected release environment", () => {
  assert.equal(job.environment, "release");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(job.permissions.contents, "write");
  assert.equal(
    job.steps.find((step) => step.uses?.startsWith("actions/setup-node@")).with[
      "node-version"
    ],
    "24.15.0",
  );
  assert.ok(
    existsSync(
      resolve(
        root,
        workflow.defaults.run["working-directory"],
        "scripts/android/publish-update-manifest.ts",
      ),
    ),
  );
  assert.ok(
    !existsSync(
      join(
        root,
        "packages/os/.github/workflows/publish-aosp-update-manifest.yml",
      ),
    ),
  );
});

test("AOSP publication refuses invalid inputs and never uploads after verification failure", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "aosp-workflow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = join(directory, "calls");
  writeFileSync(
    join(directory, "gh"),
    '#!/bin/sh\nprintf "gh %s\\n" "$*" >> "$CALLS"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(directory, "node"),
    '#!/bin/sh\nprintf "node %s\\n" "$*" >> "$CALLS"\nexit "$VERIFY_STATUS"\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    CALLS: calls,
    RUNNER_TEMP: directory,
    RELEASE_VERSION: "1.2.3",
    RELEASE_TAG: "v1.2.3",
    RELEASE_CHANNEL: "beta",
    GITHUB_REPOSITORY: "elizaos/eliza",
    VERIFY_STATUS: "0",
  };
  const run = (overrides) => {
    writeFileSync(calls, "");
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
    return { ...result, calls: readFileSync(calls, "utf8") };
  };
  for (const overrides of [
    { RELEASE_CHANNEL: "../../escape" },
    { RELEASE_TAG: "--help" },
    { RELEASE_VERSION: "bad\nversion" },
  ]) {
    const result = run(overrides);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, "");
  }
  const rejected = run({ VERIFY_STATUS: "42" });
  assert.equal(rejected.status, 42, rejected.stderr);
  assert.match(
    rejected.calls,
    /node scripts\/android\/publish-update-manifest\.ts/,
  );
  assert.doesNotMatch(rejected.calls, /gh release upload/);
  const accepted = run({});
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(
    accepted.calls,
    /gh release upload --repo elizaos\/eliza --clobber -- v1\.2\.3/,
  );
  assert.ok(
    accepted.calls.indexOf("node scripts/") <
      accepted.calls.indexOf("gh release upload"),
  );
});
