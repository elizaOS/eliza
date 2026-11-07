/**
 * A prompt turn the service kills (user stop or prompt timeout) must not be
 * reported as a completed task, even when the sub-agent already streamed some
 * output. Drives the real AcpService against a fake acpx CLI child process that
 * streams one chunk and then hangs.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpService } from "./acp-service.js";

const FAKE_ACPX = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("prompt")) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Starting work, reading files" } } },
  }) + "\\n");
  setTimeout(() => {}, 600000);
} else {
  process.exit(0);
}
`;

let workdir: string;
let cliPath: string;

function runtimeWithCli() {
  const values: Record<string, string> = {
    ELIZA_ACP_TRANSPORT: "cli",
    ELIZA_ACP_CLI: cliPath,
    ELIZA_ELIZAOS_ACP_COMMAND: "eliza-code-acp",
  };
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: (key: string) => values[key],
    getService: () => null,
    services: new Map(),
    reportError: () => {},
  } as never;
}

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "acp-killed-turn-"));
  cliPath = path.join(workdir, "fake-acpx.mjs");
  await writeFile(cliPath, FAKE_ACPX);
  await chmod(cliPath, 0o755);
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("killed ACP prompt turn", () => {
  for (const mode of ["timeout", "stop"] as const) {
    it(`is not reported as task_complete after a ${mode}`, async () => {
      const service = new AcpService(runtimeWithCli());
      const events: string[] = [];
      service.onSessionEvent((_sessionId, event) => events.push(event));
      await service.start();
      try {
        const { sessionId } = await service.spawnSession({
          name: `killed-${mode}`,
          agentType: "codex",
          workdir,
        });
        events.length = 0;

        const sent = service.sendPrompt(
          sessionId,
          "do the long task",
          mode === "timeout" ? { timeoutMs: 1500 } : {},
        );
        let stopped: Promise<void> | undefined;
        if (mode === "stop") {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          stopped = service.stopSession(sessionId);
        }
        const result = await sent;
        await stopped;

        expect(events).not.toContain("task_complete");
        expect(result.stopReason).not.toBe("end_turn");
        expect((await service.getSession(sessionId))?.status).not.toBe("ready");
      } finally {
        await service.stop();
      }
    }, 20_000);
  }
});
