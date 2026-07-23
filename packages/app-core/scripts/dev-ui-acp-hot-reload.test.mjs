/**
 * Exercises the dev host's ACP reload guard through its real process entrypoint
 * and a loopback HTTP server, without starting or killing the development stack.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "dev-ui.mjs",
);
const repoRoot = path.resolve(path.dirname(scriptPath), "../../..");
const servers = new Set();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers.clear();
});

async function startSessionServer(handler) {
  const server = createServer(handler);
  servers.add(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback test server did not expose a TCP port");
  }
  return address.port;
}

function runProbe(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--conditions=eliza-source",
        "--import",
        "tsx",
        scriptPath,
        `--check-acp-hot-reload=${port}`,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("dev-ui ACP hot-reload safety probe", () => {
  for (const status of ["busy", "running", "tool_running"]) {
    it(`defers reload for the canonical ${status} mid-flight state`, async () => {
      const port = await startSessionServer((_req, res) => {
        jsonResponse(res, 200, [{ id: "session-1", status }]);
      });

      const result = await runProbe(port);

      expect(result).toEqual({
        code: 0,
        stdout: '{"busy":true}\n',
        stderr: "",
      });
    });
  }

  it("allows reload when every session is outside the mid-flight set", async () => {
    const port = await startSessionServer((_req, res) => {
      jsonResponse(res, 200, {
        sessions: [
          { id: "ready", status: "ready" },
          { id: "done", status: "completed" },
        ],
      });
    });

    const result = await runProbe(port);

    expect(result).toEqual({
      code: 0,
      stdout: '{"busy":false}\n',
      stderr: "",
    });
  });

  it("fails observably instead of authorizing reload from an invalid payload", async () => {
    const port = await startSessionServer((_req, res) => {
      jsonResponse(res, 200, { unexpected: [] });
    });

    const result = await runProbe(port);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "ACP hot-reload safety check failed: coding-agent session check returned an invalid payload",
    );
  });

  it("fails observably instead of authorizing reload from malformed JSON", async () => {
    const port = await startSessionServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not-json");
    });

    const result = await runProbe(port);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ACP hot-reload safety check failed:");
  });

  it("fails observably instead of authorizing reload after an HTTP failure", async () => {
    const port = await startSessionServer((_req, res) => {
      jsonResponse(res, 503, { error: "store unavailable" });
    });

    const result = await runProbe(port);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "ACP hot-reload safety check failed: coding-agent session check returned HTTP 503",
    );
  });

  it("treats an explicitly absent orchestrator as having no ACP sessions", async () => {
    const port = await startSessionServer((_req, res) => {
      jsonResponse(res, 404, { error: "not found" });
    });

    const result = await runProbe(port);

    expect(result).toEqual({
      code: 0,
      stdout: '{"busy":false}\n',
      stderr: "",
    });
  });
});
