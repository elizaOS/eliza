/** Covers device E2E host env parsing before runtime or server startup. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveNonNegativeIntegerEnv,
  resolvePort,
  resolvePositiveIntegerEnv,
} from "./serve-real-local-agent";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(SCRIPT_DIR, "serve-real-local-agent.ts");
const RUN_NODE_TSX = path.join(SCRIPT_DIR, "run-node-tsx.mjs");

function runRealHost(env: NodeJS.ProcessEnv): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(process.execPath, [RUN_NODE_TSX, SCRIPT], {
      cwd: path.resolve(SCRIPT_DIR, "../../.."),
      detached,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (detached && child.pid) {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    }, 30_000);
    child.on("error", reject);
    child.on("exit", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

describe("serve-real-local-agent env parsing", () => {
  it("preserves defaults and valid explicit values", () => {
    expect(resolvePort({})).toBe(31337);
    expect(resolvePort({ ELIZA_PORT: "2142" })).toBe(2142);
    expect(resolvePort({ ELIZA_API_PORT: "31338", ELIZA_PORT: "2142" })).toBe(
      31338,
    );
    expect(resolveNonNegativeIntegerEnv("INTERVAL", "9", {})).toBe(9);
    expect(
      resolveNonNegativeIntegerEnv("INTERVAL", "9", { INTERVAL: "0" }),
    ).toBe(0);
    expect(resolvePositiveIntegerEnv("CHUNK", "4", { CHUNK: "08" })).toBe(8);
  });

  it.each([
    "31337junk",
    "31337.5",
    "+31337",
    "-1",
    " ",
    "0",
    "65536",
    "9007199254740992",
  ])("rejects malformed API port %s", (value) => {
    expect(() => resolvePort({ ELIZA_API_PORT: value })).toThrow(
      `Invalid ELIZA_API_PORT/ELIZA_PORT: ${value}`,
    );
  });

  it.each(["1junk", "1.5", "+1", "-1", " ", "9007199254740992"])(
    "rejects malformed non-negative integer %s",
    (value) => {
      expect(() =>
        resolveNonNegativeIntegerEnv("INTERVAL", "0", { INTERVAL: value }),
      ).toThrow(`INTERVAL must be a non-negative integer: ${value}`);
    },
  );

  it.each(["1junk", "1.5", "+1", "-1", " ", "0", "9007199254740992"])(
    "rejects malformed positive integer %s",
    (value) => {
      expect(() =>
        resolvePositiveIntegerEnv("CHUNK", "4", { CHUNK: value }),
      ).toThrow();
    },
  );

  it("fails the real host process before runtime creation", async () => {
    const result = await runRealHost({
      ...process.env,
      ELIZA_NODE_PATH: process.execPath,
      ELIZA_API_PORT: "31337junk",
    });

    expect(result.timedOut).toBe(false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Invalid ELIZA_API_PORT/ELIZA_PORT: 31337junk",
    );
    expect(result.stdout).not.toContain("real API up");
  });
});
