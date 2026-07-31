/**
 * Real Bun and Node child processes prove runner argv/environment signals and
 * the removed global bypass cannot alter explicit storage ownership.
 */

import { spawnSync } from "node:child_process";
import fs, { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const probe = fileURLToPath(
  new URL("./account-storage-subprocess-probe.ts", import.meta.url),
);
let container: string;

beforeEach(() => {
  container = mkdtempSync(path.join(tmpdir(), "eliza-storage-process-"));
});

afterEach(() => {
  rmSync(container, { recursive: true, force: true });
});

function runProbe(
  runtime: "bun" | "node-test",
  signals: Record<string, string>,
  root = path.join(container, runtime),
) {
  fs.mkdirSync(root, { recursive: true });
  const resultFile = path.join(container, `${runtime}-result.json`);
  const command = runtime === "bun" ? "bun" : process.execPath;
  const args =
    runtime === "bun"
      ? ["--conditions=eliza-source", probe, "vitest", "bun test", "turbo"]
      : [
          "--test",
          "--import",
          "tsx",
          "--conditions=eliza-source",
          probe,
          "--",
          "vitest",
          "bun test",
          "turbo",
        ];
  const child = spawnSync(command, args, {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      ...signals,
      ELIZA_ALLOW_REAL_STATE_IN_TESTS: "1",
      ELIZA_STORAGE_PROBE_RESULT: resultFile,
      ELIZA_STORAGE_PROBE_ROOT: root,
    },
  });
  return {
    child,
    result: fs.existsSync(resultFile)
      ? (JSON.parse(fs.readFileSync(resultFile, "utf8")) as Record<
          string,
          unknown
        >)
      : null,
  };
}

describe("account storage subprocess ownership", () => {
  it.each([
    ["bun", { BUN_ENV: "test" }],
    ["node-test", { NODE_ENV: "test", VITEST: "true", TURBO_HASH: "signal" }],
  ] as const)(
    "uses explicit isolated authority under %s",
    (runtime, signals) => {
      const { child, result } = runProbe(runtime, signals);
      expect(child.status, child.stderr).toBe(0);
      expect(result).toEqual({
        ok: true,
        owner: "isolated-test",
        remaining: false,
      });
    },
  );

  it("does not let an inherited global bypass authorize a symlink root", () => {
    const linkedRoot = path.join(container, "linked-root");
    symlinkSync(path.parse(container).root, linkedRoot, "dir");
    const { child, result } = runProbe(
      "bun",
      { VITEST: "true", TURBO_HASH: "signal" },
      linkedRoot,
    );

    expect(child.status, child.stderr).toBe(0);
    expect(result).toEqual({
      ok: false,
      code: "AUTH_CREDENTIAL_ISOLATED_ROOT_REQUIRED",
    });
  });
});
