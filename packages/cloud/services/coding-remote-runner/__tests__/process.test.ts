/** Exercises real subprocess output integrity and timeout termination through the authenticated HTTP handler. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHandler, loadConfig } from "../src/index";

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "runner-process-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function execute(source: string, limit = 100000, timeoutMs = 3000) {
  const config = loadConfig({
    ELIZA_CODING_WORKSPACE: workspace,
    ELIZA_REMOTE_RUNNER_HTTP_TOKEN: "test",
    ELIZA_REMOTE_RUNNER_MAX_COMMAND_OUTPUT_BYTES: String(limit),
  });
  return createHandler(config)(
    new Request("http://localhost/v1/processes/run", {
      method: "POST",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: process.execPath,
        args: ["-e", source],
        timeoutMs,
      }),
    }),
  );
}

test("retains complete stdout and stderr including multibyte text", async () => {
  const value = "α🦊".repeat(2000);
  const response = await execute(
    `process.stdout.write(${JSON.stringify(value)}); process.stderr.write('diagnostic')`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    stdout: value,
    stderr: "diagnostic",
    exitCode: 0,
    timedOut: false,
  });
});

test.each(["stdout", "stderr"])(
  "rejects oversized %s without a partial successful result",
  async (stream) => {
    const response = await execute(
      `process.${stream}.write('x'.repeat(10000))`,
      1024,
    );
    expect(response.status).toBe(413);
    const result = await response.json();
    expect(result.error).toContain("no partial output returned");
    expect(result.stdout).toBeUndefined();
    expect(result.stderr).toBeUndefined();
  },
);

test.skipIf(process.platform === "win32")(
  "terminates a command that ignores SIGTERM",
  async () => {
    const response = await execute(
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 100)",
      100000,
      300,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      stdout: "ready\n",
      exitCode: 124,
      timedOut: true,
    });
  },
  5000,
);

test.skipIf(process.platform === "win32")(
  "terminates descendants retaining the command output pipes",
  async () => {
    const script = `require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('descendant:' + process.pid); setInterval(() => {}, 100)"], {stdio: 'inherit'}); console.log('spawned'); process.exit(0)`;
    const response = await execute(script, 100000, 300);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    const match = /descendant:(\d+)/.exec(result.stdout);
    if (!match) throw new Error("Descendant did not report its PID");
    const pid = Number(match[1]);
    if (process.platform === "linux") {
      let state: string;
      try {
        state = await readFile(`/proc/${pid}/stat`, "utf8");
      } catch (error) {
        // error-policy:J6 An absent process confirms completed teardown.
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ESRCH")
        )
          return;
        throw error;
      }
      // Container PID1 can leave a killed adopted child as a zombie; it cannot run code or hold pipes.
      expect(
        state.slice(state.lastIndexOf(")") + 2, state.lastIndexOf(")") + 3),
      ).toBe("Z");
    } else {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  },
  5000,
);
