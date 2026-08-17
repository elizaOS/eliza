/**
 * Real POSIX subprocess regressions for native ACP process-group containment.
 * The fixtures deliberately leave descendants alive after their direct leader
 * accepts SIGTERM so close authority must be based on the whole process group.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NativeAcpClient } from "../../src/services/acp-native-transport.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath, "utf8");
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function killRecordedProcessGroup(pidFile: string): Promise<void> {
  let rawPid: string;
  try {
    rawPid = await readFile(pidFile, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  try {
    process.kill(-Number(rawPid), "SIGKILL");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ESRCH"
    ) {
      throw error;
    }
  }
}

describePosix("NativeAcpClient process-group containment", () => {
  it("kills an uncooperative adapter descendant before its delayed write", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "native-acp-tree-"));
    const adapterPath = path.join(cwd, "adapter.mjs");
    const lateMarker = path.join(cwd, "late-descendant-write.txt");
    const descendantSource = [
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('ready\\n');",
      `setTimeout(() => writeFileSync(${JSON.stringify(lateMarker)}, 'late effect'), 2200);`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const adapterSource = [
      "import { spawn } from 'node:child_process';",
      "import readline from 'node:readline';",
      // The leader obeys TERM while its descendant deliberately ignores it.
      // Direct-child exit alone must not suppress the group SIGKILL.
      "setInterval(() => {}, 1000);",
      "const input = readline.createInterface({ input: process.stdin });",
      "input.on('line', (line) => {",
      "  const request = JSON.parse(line);",
      "  if (request.method !== 'initialize') return;",
      `  const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
      "  child.stdout.once('data', () => {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');",
      "  });",
      "});",
    ].join("\n");
    await writeFile(adapterPath, adapterSource, "utf8");

    const client = new NativeAcpClient({
      command: `${process.execPath} ${adapterPath}`,
      cwd,
      approvalPreset: "autonomous",
      timeoutMs: 5_000,
    });

    try {
      await client.start();
      const startedAt = Date.now();
      await client.forceClose();
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_300);
      await new Promise((resolve) => setTimeout(resolve, 900));
      await expect(readFile(lateMarker, "utf8")).rejects.toThrow();
    } finally {
      await client.forceClose().catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  }, 8_000);

  it("awaits terminal process-group containment when its leader exits on TERM", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "native-acp-terminal-tree-"));
    const adapterPath = path.join(cwd, "adapter.mjs");
    const terminalPidFile = path.join(cwd, "terminal-pgid.txt");
    const descendantReady = path.join(cwd, "terminal-descendant-ready.txt");
    const lateMarker = path.join(cwd, "late-terminal-descendant-write.txt");
    const descendantSource = [
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      `writeFileSync(${JSON.stringify(descendantReady)}, 'ready');`,
      `setTimeout(() => writeFileSync(${JSON.stringify(lateMarker)}, 'late effect'), 2200);`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const terminalLeaderSource = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(terminalPidFile)}, String(process.pid));`,
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
      // The direct terminal leader uses Node's default SIGTERM behavior while
      // its same-group descendant ignores TERM and schedules a late effect.
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const adapterSource = [
      "import { writeFileSync } from 'node:fs';",
      "import readline from 'node:readline';",
      "const input = readline.createInterface({ input: process.stdin });",
      "input.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');",
      "    process.stdout.write(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: 'create-terminal',",
      "      method: 'terminal/create',",
      "      params: {",
      `        command: ${JSON.stringify(process.execPath)},`,
      `        args: ['-e', ${JSON.stringify(terminalLeaderSource)}],`,
      `        cwd: ${JSON.stringify(cwd)},`,
      "      },",
      "    }) + '\\n');",
      "  }",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await writeFile(adapterPath, adapterSource, "utf8");

    const client = new NativeAcpClient({
      command: `${process.execPath} ${adapterPath}`,
      cwd,
      approvalPreset: "autonomous",
      timeoutMs: 5_000,
    });

    try {
      await client.start();
      await waitForFile(descendantReady);
      const startedAt = Date.now();
      await client.forceClose();
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_300);
      await new Promise((resolve) => setTimeout(resolve, 900));
      await expect(readFile(lateMarker, "utf8")).rejects.toThrow();
    } finally {
      await client.forceClose().catch(() => {});
      await killRecordedProcessGroup(terminalPidFile);
      await rm(cwd, { recursive: true, force: true });
    }
  }, 8_000);

  it("retains a failed close handle so forceClose can retry escalation", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "native-acp-close-retry-"));
    const adapterPath = path.join(cwd, "adapter.mjs");
    const adapterPidFile = path.join(cwd, "adapter-pgid.txt");
    const descendantReady = path.join(cwd, "adapter-descendant-ready.txt");
    const descendantSource = [
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      `writeFileSync(${JSON.stringify(descendantReady)}, 'ready');`,
      "process.stdout.write('ready\\n');",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const adapterSource = [
      "import { writeFileSync } from 'node:fs';",
      "import { spawn } from 'node:child_process';",
      "import readline from 'node:readline';",
      `writeFileSync(${JSON.stringify(adapterPidFile)}, String(process.pid));`,
      "const input = readline.createInterface({ input: process.stdin });",
      "input.on('line', (line) => {",
      "  const request = JSON.parse(line);",
      "  if (request.method !== 'initialize') return;",
      `  const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
      "  child.stdout.once('data', () => {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');",
      "  });",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await writeFile(adapterPath, adapterSource, "utf8");

    const client = new NativeAcpClient({
      command: `${process.execPath} ${adapterPath}`,
      cwd,
      approvalPreset: "autonomous",
      timeoutMs: 5_000,
    });
    const realKill = process.kill.bind(process);
    let suppressFirstGroupKill = true;
    let killSpy: ReturnType<typeof vi.spyOn> | undefined;

    try {
      await client.start();
      await waitForFile(descendantReady);
      const adapterPid = Number(await readFile(adapterPidFile, "utf8"));
      killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (
          pid === -adapterPid &&
          signal === "SIGKILL" &&
          suppressFirstGroupKill
        ) {
          return true;
        }
        return realKill(pid, signal);
      });

      await expect(client.forceClose()).rejects.toThrow(
        "ACP agent did not exit after SIGKILL",
      );

      suppressFirstGroupKill = false;
      await expect(client.forceClose()).resolves.toBeUndefined();
      expect(() => realKill(-adapterPid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    } finally {
      suppressFirstGroupKill = false;
      killSpy?.mockRestore();
      await client.forceClose().catch(() => {});
      await killRecordedProcessGroup(adapterPidFile);
      await rm(cwd, { recursive: true, force: true });
    }
  }, 8_000);
});
