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
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    new URL("../../../.github/workflows/publish-apt-repo.yml", import.meta.url),
    "utf8",
  ),
);
const steps = workflow.jobs["publish-apt"].steps;

test("APT publication distinguishes missing branch from remote failure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "apt-branch-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "git"), '#!/bin/sh\nexit "$REMOTE_STATUS"\n', {
    mode: 0o755,
  });
  const script = steps.find((step) => step.id === "apt-branch").run;
  for (const status of [0, 2, 42, 128]) {
    const output = join(root, `output-${status}`);
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        REMOTE_STATUS: String(status),
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: output,
      },
      encoding: "utf8",
    });
    if (status === 0 || status === 2) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readFileSync(output, "utf8").trim(),
        status === 0 ? "exists=true" : "exists=false",
      );
    } else {
      assert.equal(result.status, status);
      assert.equal(
        existsSync(output),
        false,
        "remote failure must not publish branch absence",
      );
    }
  }
});

test("APT channel validation rejects path and shell input before publication", () => {
  const script = steps.find((step) => step.name === "Validate apt channel").run;
  for (const channel of ["stable", "beta", "../stable", "stable; exit 0", ""]) {
    const result = spawnSync("bash", ["-e", "-c", script], {
      env: { ...process.env, APT_CHANNEL: channel },
    });
    assert.equal(result.status, ["stable", "beta"].includes(channel) ? 0 : 1);
  }
  assert.ok(
    existsSync(
      new URL(
        "../../os/linux/packaging/debian/apt-repo-config/conf/distributions",
        import.meta.url,
      ),
    ),
  );
});
