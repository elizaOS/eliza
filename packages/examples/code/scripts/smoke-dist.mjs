import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function assertBunExecutable(name) {
  const executable = path.join(packageRoot, "dist", name);
  const firstLine = readFileSync(executable, "utf8").split("\n", 1)[0];
  if (firstLine !== "#!/usr/bin/env bun") {
    throw new Error(`${name} must use the Bun runtime; found ${firstLine}`);
  }
  return executable;
}

const cli = assertBunExecutable("index.js");
const acp = assertBunExecutable("acp.js");

const version = spawnSync(cli, ["--version"], {
  cwd: packageRoot,
  encoding: "utf8",
  timeout: 10_000,
});
if (version.status !== 0 || !/^eliza-code v\S+\s*$/u.test(version.stdout)) {
  throw new Error(
    `Eliza Code CLI smoke failed (status=${String(version.status)}): ${version.stderr}`,
  );
}

async function smokeAcpSession() {
  const workspace = mkdtempSync(path.join(tmpdir(), "eliza-code-dist-smoke-"));
  // The bundle intentionally externalizes workspace plugins. During a clean
  // monorepo build their dist trees may not exist yet, so run with the same
  // eliza-source condition used by development/tests. The hosted image links
  // those exact packages and repeats this smoke after assembly.
  const child = spawn("bun", ["--conditions=eliza-source", acp], {
    cwd: packageRoot,
    env: {
      ...process.env,
      CODING_TOOLS_WORKSPACE_ROOTS: workspace,
      ELIZA_RUNTIME_MODE: "local-safe",
      OPENAI_API_KEY: "synthetic-dist-smoke-key",
      OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
      OPENAI_LARGE_MODEL: "dist-smoke-model",
      OPENAI_SMALL_MODEL: "dist-smoke-model",
      PGLITE_DATA_DIR: ":memory:",
      SHELL_ALLOWED_DIRECTORY: workspace,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const responses = new Map();
  const waiters = new Map();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      responses.set(message.id, message);
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    }
  });
  const response = (id) =>
    responses.has(id)
      ? Promise.resolve(responses.get(id))
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(id);
            reject(
              new Error(
                `Eliza Code ACP response ${id} timed out: ${stderr.slice(-2000)}`,
              ),
            );
          }, 30_000);
          waiters.set(id, (message) => {
            clearTimeout(timer);
            resolve(message);
          });
        });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    const initialized = await response(1);
    if (initialized.error || initialized.result?.protocolVersion !== 1) {
      throw new Error(
        `Eliza Code ACP initialize failed: ${JSON.stringify(initialized)}`,
      );
    }
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: workspace, mcpServers: [] },
    });
    const created = await response(2);
    if (created.error || typeof created.result?.sessionId !== "string") {
      throw new Error(
        `Eliza Code ACP session/new failed: ${JSON.stringify(created)}`,
      );
    }
    child.stdin.end();
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `Eliza Code ACP did not exit after EOF: ${stderr.slice(-2000)}`,
          ),
        );
      }, 10_000);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(
        `Eliza Code ACP session smoke exited ${JSON.stringify(exit)}: ${stderr}`,
      );
    }
  } finally {
    if (!child.killed) child.kill("SIGKILL");
    rmSync(workspace, { recursive: true, force: true });
  }
}

await smokeAcpSession();

console.log("Eliza Code dist smoke passed (CLI + ACP initialize/session/new)");
