/** Exercises the native smoke verdict and teardown through keyless subprocess fixtures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

test.each([
  ["success", true],
  ["spawn-failure", false],
  ["close-failure", false],
  ["stop-failure", false],
  ...(process.platform === "win32" ? [] : [["descendant", false]]),
] as const)(
  "native smoke %s reports success only after cleanup",
  async (mode, passes) => {
    const root = await mkdtemp(path.join(tmpdir(), "native-smoke-cleanup-"));
    try {
      for (const dir of ["tests/e2e", "scripts", "dist/node"])
        await mkdir(path.join(root, dir), { recursive: true });
      for (const file of [
        "tests/e2e/live-native-acp-smoke.mjs",
        "scripts/live-pi-linked-account.mjs",
      ])
        await copyFile(path.join(packageRoot, file), path.join(root, file));
      await writeFile(path.join(root, "package.json"), '{"type":"module"}');
      await writeFile(
        path.join(root, "dist/node/index.node.js"),
        `
      import {spawn} from 'node:child_process';
      import {writeFileSync} from 'node:fs';
      const mode = ${JSON.stringify(mode)};
      export class AcpService {
        onSessionEvent(callback) { this.callback = callback; }
        async start() {}
        async spawnSession() {
          if (mode === 'spawn-failure') throw new Error('fixture spawn failed');
          if (mode === 'descendant') {
            const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
            writeFileSync(${JSON.stringify(path.join(root, "child.pid"))}, String(child.pid));
            child.unref();
          }
          return {sessionId:'fixture'};
        }
        async sendPrompt() {
          this.callback('fixture','task_complete',{});
          return {stopReason:'end_turn',finalText:'15'};
        }
        async closeSession() { if (mode === 'close-failure') throw new Error('fixture close failed'); }
        async stop() {
          console.log('FIXTURE_STOP_ATTEMPTED');
          if (mode === 'stop-failure') throw new Error('fixture stop failed');
        }
      }
      export class CodingWorkspaceService {}
    `,
      );
      const result = spawnSync(
        process.execPath,
        ["tests/e2e/live-native-acp-smoke.mjs"],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            RUN_LIVE_NATIVE_ACP: "1",
            LIVE_NATIVE_ACP_AGENT: "claude",
            ELIZA_CLAUDE_ACP_COMMAND: process.execPath,
            LIVE_NATIVE_ACP_TIMEOUT_MS: "2000",
            LIVE_NATIVE_ACP_CLEANUP_TIMEOUT_MS: "1000",
          },
          encoding: "utf8",
          timeout: 12000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, passes ? 0 : 1, result.stderr);
      assert.match(result.stdout, /FIXTURE_STOP_ATTEMPTED/);
      assert.equal(result.stdout.includes("NATIVE ACP SMOKE PASSED"), passes);
      if (passes)
        assert.ok(
          result.stdout.indexOf("cleanup complete") <
            result.stdout.indexOf("NATIVE ACP SMOKE PASSED"),
        );
      if (mode === "descendant") {
        const pid = Number(
          await readFile(path.join(root, "child.pid"), "utf8"),
        );
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
