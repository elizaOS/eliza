import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

describe.skipIf(process.platform === "win32")(
  "ACP stdio connection teardown",
  () => {
    it("hard-exits before an uncooperative handler can mutate after EOF", async () => {
      const dir = await mkdtemp(join(tmpdir(), "eliza-acp-eof-"));
      tempDirs.push(dir);
      const markerPath = join(dir, "late-write.txt");
      const fixturePath = new URL("./acp-eof-fixture.ts", import.meta.url)
        .pathname;
      const child = spawn(process.execPath, [fixturePath], {
        cwd: new URL("..", import.meta.url).pathname,
        env: {
          ...process.env,
          ELIZA_ACP_EOF_MARKER: markerPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      const promptStarted = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`fixture did not start prompt: ${stderr}`)),
          3_000,
        );
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
          if (stderr.includes("PROMPT_STARTED")) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      const write = (message: unknown): void => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      write({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      });
      write({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: dir, mcpServers: [] },
      });
      write({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: "eof-session",
          prompt: [{ type: "text", text: "write late" }],
        },
      });
      await promptStarted;

      const eofAt = Date.now();
      child.stdin.end();
      const exit = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`fixture did not exit after EOF: ${stderr}`));
        }, 3_000);
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      });
      const exitElapsedMs = Date.now() - eofAt;
      await new Promise((resolve) => setTimeout(resolve, 650));

      expect(exit).toEqual({ code: 0, signal: null });
      expect(exitElapsedMs).toBeLessThan(400);
      await expect(access(markerPath)).rejects.toThrow();
    });
  },
);
