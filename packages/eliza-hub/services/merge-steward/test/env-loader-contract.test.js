import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { mkdtempInTestRoot } from "./helpers/tmp-root.js";

const execFileAsync = promisify(execFile);
const LOADER_PATH = fileURLToPath(
  new URL(
    "../../../deployment/hetzner-staging/scripts/env-loader.sh",
    import.meta.url,
  ),
);

describe("deployment env loader", () => {
  it("exports simple env assignments without evaluating shell syntax", async () => {
    const envFile = await writeEnvFile("safe-env-", [
      "PLAIN=value",
      'QUOTED="openid email profile groups"',
      "SINGLE='single quoted value'",
      "EMPTY=",
    ]);

    const result = await runBash(
      `
      set -euo pipefail
      . "$LOADER_PATH"
      safe_load_env_file "$ENV_FILE" false test-loader
      printf '%s\\n' "$PLAIN"
      printf '%s\\n' "$QUOTED"
      printf '%s\\n' "$SINGLE"
      printf '%s\\n' "empty:\${EMPTY}"
    `,
      { ENV_FILE: envFile },
    );

    assert.deepEqual(result.stdout.trim().split("\n"), [
      "value",
      "openid email profile groups",
      "single quoted value",
      "empty:",
    ]);
  });

  it("rejects command substitution instead of executing private env contents", async () => {
    const dir = await mkdtempInTestRoot("unsafe-env-");
    const envFile = path.join(dir, ".env");
    const marker = path.join(dir, "executed");
    await writeFile(
      envFile,
      `SAFE=value\nMALICIOUS=$(touch "${marker}")\n`,
      "utf8",
    );

    const result = await runBash(
      `
      set -euo pipefail
      . "$LOADER_PATH"
      if safe_load_env_file "$ENV_FILE" false test-loader; then
        exit 10
      fi
      exit 0
    `,
      { ENV_FILE: envFile },
    );

    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(access(marker));
    assert.match(result.stderr, /command substitution is not allowed/);
  });
});

async function writeEnvFile(prefix, lines) {
  const dir = await mkdtempInTestRoot(prefix);
  const envFile = path.join(dir, ".env");
  await writeFile(envFile, `${lines.join("\n")}\n`, "utf8");
  return envFile;
}

async function runBash(script, env = {}) {
  try {
    const result = await execFileAsync("bash", ["-c", script], {
      env: {
        PATH: process.env.PATH,
        LOADER_PATH,
        ...env,
      },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}
