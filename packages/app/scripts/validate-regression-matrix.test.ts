import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("checks executable release suites without retired inventory documents", () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const fixture = mkdtempSync(path.join(tmpdir(), "regression-matrix-"));
  try {
    mkdirSync(path.join(fixture, ".github/workflows"), { recursive: true });
    cpSync(path.join(repo, "package.json"), path.join(fixture, "package.json"));
    symlinkSync(
      path.join(repo, "packages"),
      path.join(fixture, "packages"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const workflow = ".github/workflows/release-electrobun.yml";
    cpSync(path.join(repo, workflow), path.join(fixture, workflow));
    const run = () =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("./validate-regression-matrix.ts", import.meta.url),
          ),
          "--workflow",
          "release",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            ELIZA_REGRESSION_MATRIX_REPO_ROOT: fixture,
            GITHUB_BASE_SHA: "",
            GITHUB_BASE_REF: "",
          },
        },
      );
    const valid = run();
    expect(valid.status, valid.stdout + valid.stderr).toBe(0);
    writeFileSync(
      path.join(fixture, workflow),
      readFileSync(path.join(fixture, workflow), "utf8").replaceAll(
        "bun run test:e2e:heavy",
        "echo removed-heavy-test",
      ),
    );
    const invalid = run();
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout + invalid.stderr).toContain(
      'does not schedule "e2e-heavy"',
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
