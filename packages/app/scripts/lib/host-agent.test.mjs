/**
 * Deterministic unit coverage for the device-e2e host-agent helper: port
 * selection exclusivity, readiness knob validation, health wait + stop lifecycle,
 * and spawn failure cleanup.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ADVERTISEMENT_POLL_INTERVAL_MS,
  DEFAULT_READY_ATTEMPTS,
  DEFAULT_READY_DELAY_MS,
  hostAgentApiBase,
  MAX_TIMER_DELAY_MS,
  parseNonNegativeSafeInteger,
  parsePort,
  parsePositiveSafeInteger,
  resolveAdvertisementWaitOptions,
  resolveReadyOptions,
  startDeviceE2eHostAgent,
} from "./host-agent.mjs";

const tmpDirs = [];
const PINNED_NODE_VERSION = "24.15.0";

function resolvePinnedNode() {
  const candidates = [];
  if (process.env.ELIZA_NODE_PATH) {
    candidates.push(process.env.ELIZA_NODE_PATH);
  }
  const nvmDir = process.env.NVM_DIR ?? path.join(os.homedir(), ".nvm");
  candidates.push(
    path.join(
      nvmDir,
      "versions",
      "node",
      `v${PINNED_NODE_VERSION}`,
      "bin",
      "node",
    ),
  );
  const lookup = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["node"],
    {
      encoding: "utf8",
    },
  );
  if (lookup.status === 0) {
    candidates.push(...lookup.stdout.trim().split(/\r?\n/));
  }
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (
      result.status === 0 &&
      result.stdout.trim() === `v${PINNED_NODE_VERSION}`
    ) {
      return candidate;
    }
  }
  throw new Error(
    `Pinned Node.js ${PINNED_NODE_VERSION} is required for this real-process regression; set ELIZA_NODE_PATH or install it through the repository toolchain.`,
  );
}

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-host-agent-test-"));
  tmpDirs.push(dir);
  return dir;
}

function fakeHostAgentScript() {
  return `
    const fs = require("node:fs");
    const http = require("node:http");
    const port = Number.parseInt(process.env.ELIZA_API_PORT, 10);
    const server = http.createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, pairingDisabled: process.env.ELIZA_PAIRING_DISABLED }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    server.listen(port, "127.0.0.1", () => {
      const portFile = process.env.ELIZA_E2E_PORT_FILE;
      if (portFile) {
        const actualPort = server.address().port;
        const tmp = portFile + "." + process.pid + ".tmp";
        fs.writeFileSync(tmp, actualPort + "\\n", "utf8");
        fs.renameSync(tmp, portFile);
      }
      console.log("fake host agent up on :" + port);
    });
    const stop = () => server.close(() => process.exit(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  `;
}

async function listen(port = 0) {
  const server = http.createServer((_, response) => {
    response.writeHead(200);
    response.end("occupied");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("host-agent helper", () => {
  it("validates ports without coercing malformed values", () => {
    expect(parsePort("31338")).toBe(31338);
    for (const value of ["", "0", "-1", "123abc", "70000"]) {
      expect(() => parsePort(value)).toThrow(/Invalid/);
    }
  });

  it("parses positive and non-negative safe integers without partial coercion", () => {
    expect(parsePositiveSafeInteger("90", "attempts")).toBe(90);
    expect(parsePositiveSafeInteger(50, "attempts")).toBe(50);
    expect(parseNonNegativeSafeInteger("0", "delay")).toBe(0);
    expect(parseNonNegativeSafeInteger(2000, "delay")).toBe(2000);

    for (const value of ["", "abc", "10abc", "1.5", "-1", "0", NaN, 1.5]) {
      expect(() => parsePositiveSafeInteger(value, "attempts")).toThrow(
        /Invalid attempts/,
      );
    }
    for (const value of ["", "abc", "10abc", "1.5", "-1", " 2000 ", NaN, -3]) {
      expect(() => parseNonNegativeSafeInteger(value, "delay")).toThrow(
        /Invalid delay/,
      );
    }
  });

  it("resolves readiness knobs from options and env, failing closed on typos", () => {
    expect(resolveReadyOptions({})).toEqual({
      readyAttempts: DEFAULT_READY_ATTEMPTS,
      readyDelayMs: DEFAULT_READY_DELAY_MS,
    });
    expect(
      resolveReadyOptions({
        readyAttempts: 12,
        readyDelayMs: 0,
      }),
    ).toEqual({ readyAttempts: 12, readyDelayMs: 0 });
    expect(
      resolveReadyOptions({
        env: {
          ELIZA_HOST_AGENT_READY_ATTEMPTS: "7",
          ELIZA_HOST_AGENT_READY_DELAY_MS: "25",
        },
      }),
    ).toEqual({ readyAttempts: 7, readyDelayMs: 25 });
    expect(
      resolveReadyOptions({
        env: {
          ELIZA_HOST_AGENT_READY_ATTEMPTS: "   ",
          ELIZA_HOST_AGENT_READY_DELAY_MS: "",
        },
      }),
    ).toEqual({
      readyAttempts: DEFAULT_READY_ATTEMPTS,
      readyDelayMs: DEFAULT_READY_DELAY_MS,
    });

    expect(() =>
      resolveReadyOptions({
        env: { ELIZA_HOST_AGENT_READY_ATTEMPTS: "abc" },
      }),
    ).toThrow(/Invalid host-agent readyAttempts/);
    expect(() =>
      resolveReadyOptions({
        env: { ELIZA_HOST_AGENT_READY_DELAY_MS: "10ms" },
      }),
    ).toThrow(/Invalid host-agent readyDelayMs/);
    expect(() => resolveReadyOptions({ readyAttempts: "0" })).toThrow(
      /Invalid host-agent readyAttempts/,
    );
    expect(() => resolveReadyOptions({ readyAttempts: null })).toThrow(
      /Invalid host-agent readyAttempts/,
    );
    expect(() => resolveReadyOptions({ readyDelayMs: null })).toThrow(
      /Invalid host-agent readyDelayMs/,
    );
    for (const value of ["", "   "]) {
      expect(() => resolveReadyOptions({ readyAttempts: value })).toThrow(
        /Invalid host-agent readyAttempts/,
      );
      expect(() => resolveReadyOptions({ readyDelayMs: value })).toThrow(
        /Invalid host-agent readyDelayMs/,
      );
    }
    expect(() =>
      resolveReadyOptions({
        env: { ELIZA_HOST_AGENT_READY_DELAY_MS: " 2000 " },
      }),
    ).toThrow(/Invalid host-agent readyDelayMs/);
    expect(() =>
      resolveReadyOptions({
        env: {
          ELIZA_HOST_AGENT_READY_DELAY_MS: String(MAX_TIMER_DELAY_MS + 1),
        },
      }),
    ).toThrow(`no greater than ${MAX_TIMER_DELAY_MS}`);
  });

  it("derives short and extended advertisement timeouts from readiness", () => {
    expect(
      resolveAdvertisementWaitOptions({
        readyAttempts: 2,
        readyDelayMs: 20,
      }),
    ).toEqual({ timeoutMs: 40, pollIntervalMs: 40 });
    expect(
      resolveAdvertisementWaitOptions({
        readyAttempts: DEFAULT_READY_ATTEMPTS,
        readyDelayMs: DEFAULT_READY_DELAY_MS,
      }),
    ).toEqual({
      timeoutMs: 180_000,
      pollIntervalMs: DEFAULT_ADVERTISEMENT_POLL_INTERVAL_MS,
    });
    expect(
      resolveAdvertisementWaitOptions({
        readyAttempts: 3,
        readyDelayMs: 0,
      }),
    ).toEqual({ timeoutMs: 3, pollIntervalMs: 3 });
    expect(() =>
      resolveAdvertisementWaitOptions({
        readyAttempts: Number.MAX_SAFE_INTEGER,
        readyDelayMs: 2,
      }),
    ).toThrow(/readiness budget/);
  });

  it("uses a short readiness budget when a live child never advertises", async () => {
    const artifactDir = makeTmpDir();
    const startedAt = Date.now();
    await expect(
      startDeviceE2eHostAgent({
        repoRoot: process.cwd(),
        artifactDir,
        readyAttempts: 2,
        readyDelayMs: 20,
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000)"],
        env: {},
      }),
    ).rejects.toThrow(/timed out after 40ms/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(
      fs
        .readdirSync(artifactDir)
        .filter((entry) => entry.startsWith(".host-agent-port-")),
    ).toEqual([]);
    fs.rmSync(path.join(artifactDir, "host-agent.log"));
  });

  it("shares one signal coordinator while concurrent children are starting", async () => {
    const signalCounts = new Map(
      ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
        signal,
        process.listenerCount(signal),
      ]),
    );
    const starts = Array.from({ length: 12 }, (_, index) =>
      startDeviceE2eHostAgent({
        repoRoot: process.cwd(),
        artifactDir: path.join(makeTmpDir(), String(index)),
        readyAttempts: 10,
        readyDelayMs: 20,
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000)"],
        env: {},
      }),
    );

    for (const [signal, count] of signalCounts) {
      expect(process.listenerCount(signal)).toBe(count + 1);
    }
    const results = await Promise.allSettled(starts);
    expect(results).toHaveLength(12);
    expect(
      results.every(
        (result) =>
          result.status === "rejected" &&
          /timed out after 200ms/.test(String(result.reason)),
      ),
    ).toBe(true);
    for (const [signal, count] of signalCounts) {
      expect(process.listenerCount(signal)).toBe(count);
    }
  });

  it("rejects invalid readyAttempts before spawning a host agent child", async () => {
    const artifactDir = makeTmpDir();
    await expect(
      startDeviceE2eHostAgent({
        repoRoot: process.cwd(),
        artifactDir,
        requestedPort: 31338,
        readyAttempts: "10abc",
        readyDelayMs: 20,
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: {},
      }),
    ).rejects.toThrow(/Invalid host-agent readyAttempts/);
    expect(fs.existsSync(path.join(artifactDir, "host-agent.log"))).toBe(false);
  });

  it("rejects an overflowing delay before creating the artifact or child", async () => {
    const artifactDir = makeTmpDir();
    await expect(
      startDeviceE2eHostAgent({
        repoRoot: process.cwd(),
        artifactDir,
        requestedPort: 31338,
        readyAttempts: 2,
        readyDelayMs: MAX_TIMER_DELAY_MS + 1,
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: {},
      }),
    ).rejects.toThrow(/Invalid host-agent readyDelayMs/);
    expect(fs.existsSync(path.join(artifactDir, "host-agent.log"))).toBe(false);
  });

  it("rejects overflowing delay under pinned Node before spawn", () => {
    const pinnedNode = resolvePinnedNode();
    const artifactDir = makeTmpDir();
    const moduleUrl = new URL("./host-agent.mjs", import.meta.url).href;
    const script = `
      import { startDeviceE2eHostAgent, MAX_TIMER_DELAY_MS } from ${JSON.stringify(moduleUrl)};
      try {
        await startDeviceE2eHostAgent({
          repoRoot: process.cwd(),
          artifactDir: process.env.TEST_ARTIFACT_DIR,
          readyAttempts: 2,
          readyDelayMs: MAX_TIMER_DELAY_MS + 1,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          env: {},
        });
        process.exit(1);
      } catch (error) {
        if (!/Invalid host-agent readyDelayMs/.test(String(error?.message))) process.exit(2);
        process.stdout.write("rejected-before-spawn");
      }
    `;
    const result = spawnSync(
      pinnedNode,
      ["--input-type=module", "-e", script],
      {
        encoding: "utf8",
        env: { ...process.env, TEST_ARTIFACT_DIR: artifactDir },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("TimeoutOverflowWarning");
    expect(result.stdout).toContain("rejected-before-spawn");
    expect(fs.existsSync(path.join(artifactDir, "host-agent.log"))).toBe(false);
  });

  it("keeps explicit requested ports strict when already occupied", async () => {
    const server = await listen();
    const signalCounts = new Map(
      ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
        signal,
        process.listenerCount(signal),
      ]),
    );
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      await expect(
        startDeviceE2eHostAgent({
          repoRoot: process.cwd(),
          artifactDir: makeTmpDir(),
          requestedPort: port,
          readyAttempts: 50,
          readyDelayMs: 20,
          command: process.execPath,
          args: ["-e", fakeHostAgentScript()],
          env: {},
        }),
      ).rejects.toThrow(/exited|EADDRINUSE|health/i);
      for (const [signal, count] of signalCounts) {
        expect(process.listenerCount(signal)).toBe(count);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("lets the child bind a kernel-assigned port, then waits for health and stops it", async () => {
    const artifactDir = makeTmpDir();
    const agent = await startDeviceE2eHostAgent({
      repoRoot: process.cwd(),
      artifactDir,
      readyAttempts: 250,
      readyDelayMs: 20,
      command: process.execPath,
      args: ["-e", fakeHostAgentScript()],
      env: {},
    });

    expect(agent.apiBase).toBe(hostAgentApiBase(agent.port));
    expect(agent.port).toBeGreaterThan(0);
    const response = await fetch(`${agent.apiBase}/api/health`);
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({
      ok: true,
      pairingDisabled: "1",
    });

    await agent.stop();
    expect(
      fs
        .readdirSync(artifactDir)
        .filter((entry) => entry.startsWith(".host-agent-port-")),
    ).toEqual([]);
    expect(fs.readFileSync(agent.logPath, "utf8")).toContain(
      "fake host agent up on :0",
    );

    const probe = spawnSync(process.execPath, [
      "-e",
      `
        fetch("${agent.apiBase}/api/health")
          .then(() => process.exit(1))
          .catch(() => process.exit(0));
      `,
    ]);
    expect(probe.status).toBe(0);
  });

  it("starts concurrent children on distinct bound ports without probe races", async () => {
    const signalCounts = new Map(
      ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
        signal,
        process.listenerCount(signal),
      ]),
    );
    const agents = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        startDeviceE2eHostAgent({
          repoRoot: process.cwd(),
          artifactDir: path.join(makeTmpDir(), String(index)),
          readyAttempts: 500,
          readyDelayMs: 10,
          command: process.execPath,
          args: ["-e", fakeHostAgentScript()],
          env: {},
        }),
      ),
    );
    try {
      for (const [signal, count] of signalCounts) {
        expect(process.listenerCount(signal)).toBe(count + 1);
      }
      expect(new Set(agents.map((agent) => agent.port)).size).toBe(12);
      const responses = await Promise.all(
        agents.map((agent) => fetch(`${agent.apiBase}/api/health`)),
      );
      expect(responses.every((response) => response.ok)).toBe(true);
    } finally {
      await Promise.all(agents.map((agent) => agent.stop()));
    }
    for (const [signal, count] of signalCounts) {
      expect(process.listenerCount(signal)).toBe(count);
    }
  });

  it("fails fast and closes the log fd when the child cannot spawn", async () => {
    const artifactDir = makeTmpDir();
    await expect(
      startDeviceE2eHostAgent({
        repoRoot: process.cwd(),
        artifactDir,
        readyAttempts: 2,
        readyDelayMs: 20,
        command: path.join(artifactDir, "missing-node"),
        args: ["--version"],
      }),
    ).rejects.toThrow(/Host agent failed to start|ENOENT/);

    fs.rmSync(path.join(artifactDir, "host-agent.log"));
    expect(fs.existsSync(path.join(artifactDir, "host-agent.log"))).toBe(false);
  });
});
