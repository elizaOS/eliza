/** Covers device E2E host env parsing before runtime or server startup. */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signalSpawnedProcessTree } from "./lib/kill-process-tree.mjs";
import {
  resolveNonNegativeIntegerEnv,
  resolvePort,
  resolvePositiveIntegerEnv,
} from "./serve-real-local-agent";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(SCRIPT_DIR, "serve-real-local-agent.ts");
const RUN_NODE_TSX = path.join(SCRIPT_DIR, "run-node-tsx.mjs");
const PROCESS_TREE_LISTENER = path.join(
  SCRIPT_DIR,
  "fixtures/process-tree-listener.mjs",
);

function runWrappedScript({
  detached = process.platform !== "win32",
  env,
  script = SCRIPT,
  timeoutMs = 30_000,
  timeoutSignal = process.platform === "win32" ? "SIGKILL" : "SIGTERM",
}: {
  detached?: boolean;
  env: NodeJS.ProcessEnv;
  script?: string;
  timeoutMs?: number;
  timeoutSignal?: NodeJS.Signals;
}): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUN_NODE_TSX, script], {
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
      signalSpawnedProcessTree(child, timeoutSignal);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("free-port probe did not return a TCP address"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForTreeRelease(pid: number, port: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid) && (await canListen(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid) && (await canListen(port));
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
    const result = await runWrappedScript({
      env: {
        ...process.env,
        ELIZA_NODE_PATH: process.execPath,
        ELIZA_API_PORT: "31337junk",
      },
    });

    expect(result.timedOut).toBe(false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Invalid ELIZA_API_PORT/ELIZA_PORT: 31337junk",
    );
    expect(result.stdout).not.toContain("real API up");
  });

  it("terminates the wrapper descendant and releases its listener port", async () => {
    const port = await getFreePort();
    const result = await runWrappedScript({
      detached: false,
      env: {
        ...process.env,
        ELIZA_NODE_PATH: process.execPath,
        PROCESS_TREE_LISTENER_PORT: String(port),
      },
      script: PROCESS_TREE_LISTENER,
      timeoutMs: 2_000,
      // Windows ChildProcess.kill terminates the wrapper without delivering a
      // catchable POSIX signal. SIGKILL reproduces that lifecycle on Unix.
      timeoutSignal: "SIGKILL",
    });
    const match = result.stdout.match(
      /\[process-tree-listener\] ready pid=(\d+) port=(\d+)/,
    );
    expect(match).not.toBeNull();
    const descendantPid = Number(match?.[1]);

    try {
      expect(result.timedOut).toBe(true);
      expect(Number(match?.[2])).toBe(port);
      expect(await waitForTreeRelease(descendantPid, port)).toBe(true);
    } finally {
      if (isPidAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    }
  });
});
