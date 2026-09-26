import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

test("source updater refuses failed, incomplete, or conflicted submodule inspection", () => {
  const workflow = parse(
    readFileSync(
      new URL(
        "../../../.github/workflows/update-eliza-source-lock.yml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const step = workflow.jobs.update.steps.find(
    (entry) => entry.id === "identity",
  );
  const commit = "a".repeat(40);
  const script = step.run.replace(
    "$" + "{{ steps.source.outputs.commit }}",
    commit,
  );
  const directory = mkdtempSync(path.join(os.tmpdir(), "os-source-workflow-"));
  try {
    writeFileSync(
      path.join(directory, "git"),
      `#!/bin/sh
case "$1" in
  rev-parse) echo '${commit}' ;;
  submodule)
    case "$SCENARIO" in
      failure) exit 42 ;;
      missing) printf '%s\\n' '-${commit} dependency' ;;
      changed) printf '%s\\n' '+${commit} dependency' ;;
      conflict) printf '%s\\n' 'U${commit} dependency' ;;
      healthy) printf '%s\\n' ' ${commit} dependency' ;;
      *) exit 43 ;;
    esac ;;
  show) echo '2026-09-23T17:00:00-07:00' ;;
  *) exit 44 ;;
esac
`,
      { mode: 0o755 },
    );
    for (const scenario of [
      "failure",
      "missing",
      "changed",
      "conflict",
      "healthy",
    ]) {
      const output = path.join(directory, `${scenario}.output`);
      const result = spawnSync("bash", ["-c", script], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          SCENARIO: scenario,
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
      });
      assert.ifError(result.error);
      if (scenario === "healthy") {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          readFileSync(output, "utf8"),
          "commit-timestamp=2026-09-24T00:00:00Z\n",
        );
      } else {
        assert.equal(result.status, scenario === "failure" ? 42 : 1);
        assert.equal(
          existsSync(output),
          false,
          "failed inspection must not publish identity outputs",
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
