/**
 * Exercises the shared development API child launcher against real Bun and
 * Node subprocesses, including the environment visible inside each child and
 * the nonzero failure observed when its entrypoint cannot load.
 */
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDevApiChildEnv, spawnDevApiChild } from "./lib/dev-api-child.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const probePath = path.join(scriptsDir, "fixtures", "dev-api-child-probe.mjs");

async function runChild(options) {
  const child = spawnDevApiChild({
    ...options,
    cwd: scriptsDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code, signal] = await once(child, "close");
  return { code, signal, stdout, stderr };
}

describe.each([
  ["dev-platform", "bun", "bun"],
  ["dev-ui", "node", process.execPath],
])("%s API child", (_name, runtime, executable) => {
  it("receives the source-aware runtime argv and isolated API environment", async () => {
    const { env } = buildDevApiChildEnv({
      ...process.env,
      ELIZA_CONTRACT_MARKER: "observed",
      ELIZA_MOCK_GOOGLE_BASE: "http://mock.invalid",
      ELIZA_WALLET_OS_STORE: runtime === "node" ? "1" : "",
      VITE_ELIZA_IOS_RUNTIME_MODE: "remote",
      VITE_ELIZA_MOBILE_RUNTIME_MODE: "remote",
    });
    const result = await runChild({
      executable,
      runtime,
      entryPath: probePath,
      env,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    const observed = JSON.parse(result.stdout.trim());
    expect(observed.execArgv).toContain("--conditions=eliza-source");
    if (runtime === "bun") {
      expect(observed.execArgv).toContain("--no-install");
    } else {
      expect(observed.execArgv).toEqual(
        expect.arrayContaining(["--import", "tsx"]),
      );
      expect(observed.execArgv).not.toContain("--no-install");
    }
    expect(observed.env).toEqual({
      ELIZA_CONTRACT_MARKER: "observed",
      ELIZA_MOCK_GOOGLE_BASE: null,
      ELIZA_WALLET_OS_STORE: runtime === "node" ? "1" : "0",
      VITE_ELIZA_IOS_RUNTIME_MODE: null,
      VITE_ELIZA_MOBILE_RUNTIME_MODE: null,
    });
  });
});

it("surfaces an entrypoint load failure as a nonzero child exit", async () => {
  const missingEntry = path.join(
    scriptsDir,
    "fixtures",
    "missing-api-child.mjs",
  );
  const result = await runChild({
    executable: process.execPath,
    runtime: "node",
    entryPath: missingEntry,
    env: process.env,
  });

  expect(result.code).not.toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toContain("missing-api-child.mjs");
});
