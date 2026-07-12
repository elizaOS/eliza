import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { mkdtempInTestRoot } from "./helpers/tmp-root.js";

const execFileAsync = promisify(execFile);
const HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/runner-smoke-evidence.mjs",
  import.meta.url,
);

describe("runner smoke evidence helper", () => {
  it("generates private evidence from a passing Forgejo Actions run", async () => {
    const requests = [];
    const server = await startServer((req, res) => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
      });
      writeJson(res, {
        workflow_runs: [
          {
            id: 42,
            run_number: 7,
            path: ".forgejo/workflows/runner-smoke.yml",
            head_branch: "main",
            status: "completed",
            conclusion: "success",
            html_url: `${server.url}/elizaos/eliza/actions/runs/7`,
          },
        ],
      });
    });
    const envFile = await writeTempEnv({
      FORGEJO_ROOT_URL: server.url,
      FORGEJO_STEWARD_TOKEN: "forgejo-token-do-not-print",
    });
    const output = path.join(path.dirname(envFile), "runner-smoke.json");

    try {
      const result = await runHelper(envFile, output, [
        "--repo",
        "elizaos/eliza",
        "--workflow",
        "runner-smoke.yml",
        "--ref",
        "main",
      ]);
      const evidence = JSON.parse(await readFile(output, "utf8"));

      assert.equal(result.code, 0, result.stderr);
      assert.equal(evidence.runnerSmoke.trustedWorkflowPassed, true);
      assert.equal(evidence.runnerSmoke.repository, "elizaos/eliza");
      assert.equal(
        evidence.runnerSmoke.workflowRunUrl,
        `${server.url}/elizaos/eliza/actions/runs/7`,
      );
      assert.deepEqual(
        requests.map((request) => `${request.method} ${request.url}`),
        ["GET /api/v1/repos/elizaos/eliza/actions/runs?limit=20"],
      );
      assert.equal(
        requests[0].authorization,
        "token forgejo-token-do-not-print",
      );
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /forgejo-token-do-not-print/,
      );
    } finally {
      await server.close();
    }
  });

  it("dispatches the trusted workflow only when explicitly requested", async () => {
    const requests = [];
    const server = await startServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      if (req.method === "POST") {
        res.writeHead(204);
        res.end();
        return;
      }

      writeJson(res, {
        workflow_runs: [
          {
            id: 43,
            run_number: 8,
            path: ".forgejo/workflows/runner-smoke.yml",
            head_branch: "main",
            created_at: new Date().toISOString(),
            status: "completed",
            conclusion: "success",
          },
        ],
      });
    });
    const envFile = await writeTempEnv({
      FORGEJO_ROOT_URL: server.url,
      FORGEJO_STEWARD_TOKEN: "forgejo-token-do-not-print",
    });
    const output = path.join(path.dirname(envFile), "runner-smoke.json");

    try {
      const result = await runHelper(envFile, output, [
        "--dispatch",
        "--repo",
        "elizaos/eliza",
        "--timeout-ms",
        "1000",
        "--interval-ms",
        "10",
      ]);

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(
        requests.map((request) => `${request.method} ${request.url}`),
        [
          "POST /api/v1/repos/elizaos/eliza/actions/workflows/runner-smoke.yml/dispatches",
          "GET /api/v1/repos/elizaos/eliza/actions/runs?limit=20",
        ],
      );
    } finally {
      await server.close();
    }
  });
});

async function runHelper(envFile, output, args = []) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [HELPER_PATH.pathname, "--output", output, ...args],
      {
        env: {
          PATH: process.env.PATH,
          ENV_FILE: envFile,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function writeTempEnv(values) {
  const dir = await mkdtempInTestRoot("runner-smoke-env-");
  const envFile = path.join(dir, ".env");
  await writeFile(
    envFile,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    "utf8",
  );
  return envFile;
}

function startServer(handler) {
  const server = createServer(handler);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const wrapped = {
        url: `http://127.0.0.1:${address.port}/`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) =>
              error ? closeReject(error) : closeResolve(),
            );
          }),
      };
      resolve(wrapped);
    });
  });
}

function writeJson(res, body) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
