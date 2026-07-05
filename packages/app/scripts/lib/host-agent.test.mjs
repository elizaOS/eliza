import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chooseHostAgentPort,
  DEFAULT_HOST_AGENT_PORT,
  hostAgentApiBase,
  isPortAvailable,
  parsePort,
  startDeviceE2eHostAgent,
} from "./host-agent.mjs";

const tmpDirs = [];

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
