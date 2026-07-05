import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chooseHostAgentPort,
  findOpenTcpPort,
  parsePositivePort,
  resolveHostAgentRequestedPort,
  startHostAgent,
} from "./host-agent.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-agent-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("host-agent helper", () => {
  it("parses only valid positive TCP ports", () => {
    expect(parsePositivePort("31338")).toBe(31338);
    expect(parsePositivePort(undefined)).toBe(null);
    expect(() => parsePositivePort("0")).toThrow(/Invalid/);
    expect(() => parsePositivePort("65536")).toThrow(/Invalid/);
    expect(() => parsePositivePort("31338abc")).toThrow(/Invalid/);
  });

  it("resolves --host-agent-port before env", () => {
    expect(
      resolveHostAgentRequestedPort(["--host-agent-port", "44444"], {
        ELIZA_HOST_AGENT_PORT: "33333",
      }),
    ).toBe(44444);
    expect(
      resolveHostAgentRequestedPort([], { ELIZA_HOST_AGENT_PORT: "33333" }),
    ).toBe(33333);
  });

  it("uses a requested free port and rejects a requested occupied port", async () => {
    await expect(
      chooseHostAgentPort({
        requestedPort: 45678,
        checkPortAvailable: async () => true,
      }),
    ).resolves.toBe(45678);
    await expect(
      chooseHostAgentPort({
        requestedPort: 45678,
        checkPortAvailable: async () => false,
      }),
    ).rejects.toThrow(/already in use/);
  });

  it("falls back to an allocated free port when the preferred port is occupied", async () => {
    await expect(
      chooseHostAgentPort({
        preferredPort: 31338,
        checkPortAvailable: async (port) => port !== 31338,
        allocateFreePort: async () => 45679,
      }),
    ).resolves.toBe(45679);
  });

  it("starts a subprocess, waits for /api/health, writes logs, and stops it", async () => {
    const dir = makeTempDir();
    const serverPath = path.join(dir, "server.mjs");
    fs.writeFileSync(
      serverPath,
      `
import http from "node:http";
const port = Number.parseInt(process.env.ELIZA_API_PORT, 10);
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1", () => {
  console.log("test host agent ready", port);
});
process.once("SIGTERM", () => server.close(() => process.exit(0)));
      `.trim(),
      "utf8",
    );
    const preferredPort = await findOpenTcpPort();
    const logPath = path.join(dir, "host-agent.log");
    const agent = await startHostAgent({
      repoRoot: dir,
      preferredPort,
      logPath,
      command: process.execPath,
      args: [serverPath],
      signalSafe: false,
      healthAttempts: 20,
      healthDelayMs: 50,
      healthTimeoutMs: 500,
    });

    expect(agent.apiBase).toBe(`http://127.0.0.1:${preferredPort}`);
    await expect(fetch(`${agent.apiBase}/api/health`)).resolves.toMatchObject({
      ok: true,
    });
    await agent.stop("test");
    expect(fs.readFileSync(logPath, "utf8")).toContain(
      "[host-agent-helper] starting",
    );
    expect(fs.readFileSync(logPath, "utf8")).toContain("test host agent ready");
    await expect(fetch(`${agent.apiBase}/api/health`)).rejects.toThrow();
  });
});
