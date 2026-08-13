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
  chooseHostAgentPort,
  DEFAULT_HOST_AGENT_PORT,
  DEFAULT_READY_ATTEMPTS,
  DEFAULT_READY_DELAY_MS,
  hostAgentApiBase,
  isPortAvailable,
  MAX_TIMER_DELAY_MS,
  parseNonNegativeSafeInteger,
  parsePort,
  parsePositiveSafeInteger,
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
    expect(parsePort("31338")).toBe(DEFAULT_HOST_AGENT_PORT);
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
    ).toThrow(/Invalid host-agent readyDelayMs/);
  });

  it("rejects invalid readyAttempts before spawning a host agent child", async () => {
    const artifactDir = makeTmpDir();
    await expect(
      startDeviceE2eHostAgent({
        repoRoot: process.cwd(),
        artifactDir,
        requestedPort: await chooseHostAgentPort(),
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
        requestedPort: await chooseHostAgentPort(),
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

  it("keeps explicit requested ports exclusive", async () => {
    const server = await listen();
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      await expect(
        chooseHostAgentPort({ requestedPort: port }),
      ).rejects.toThrow(`Requested host-agent port ${port} is already in use.`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("falls back to a free port when the preferred default is occupied", async () => {
    const server = await listen();
    try {
      const address = server.address();
      const occupiedPort =
        typeof address === "object" && address ? address.port : 0;
      const selected = await chooseHostAgentPort({
        preferredPort: occupiedPort,
      });
      expect(selected).not.toBe(occupiedPort);
      expect(await isPortAvailable(selected)).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("starts a child host agent, waits for health, writes logs, and stops it", async () => {
    const artifactDir = makeTmpDir();
    const requestedPort = await chooseHostAgentPort();
    const agent = await startDeviceE2eHostAgent({
      repoRoot: process.cwd(),
      artifactDir,
      requestedPort,
      readyAttempts: 50,
      readyDelayMs: 20,
      command: process.execPath,
      args: ["-e", fakeHostAgentScript()],
      env: {},
    });

    expect(agent.apiBase).toBe(hostAgentApiBase(requestedPort));
    const response = await fetch(`${agent.apiBase}/api/health`);
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({
      ok: true,
      pairingDisabled: "1",
    });

    await agent.stop();
    expect(fs.readFileSync(agent.logPath, "utf8")).toContain(
      `fake host agent up on :${requestedPort}`,
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

  it("fails fast and closes the log fd when the child cannot spawn", async () => {
    const artifactDir = makeTmpDir();
    await expect(
      startDeviceE2eHostAgent({
        repoRoot: process.cwd(),
        artifactDir,
        requestedPort: await chooseHostAgentPort(),
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
