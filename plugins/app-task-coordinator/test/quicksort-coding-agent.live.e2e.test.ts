import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import {
  PTYService,
  spawnAgentAction,
} from "@elizaos/plugin-agent-orchestrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";
import { createRealTestRuntime } from "../../../test/helpers/real-runtime";
import { cleanForChat } from "../../../plugins/plugin-agent-orchestrator/src/services/ansi-utils.ts";

const LIVE_TESTS_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const KEEP_ARTIFACTS = process.env.ELIZA_KEEP_LIVE_ARTIFACTS === "1";

type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

function createMessage(content: Record<string, unknown> = {}) {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    userId: "live-user",
    roomId: "live-room",
    createdAt: Date.now(),
    content,
  };
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await wait(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `${command} timed out after ${Math.round(options.timeoutMs / 1000)} seconds`,
        ),
      );
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

async function canRunCodex(): Promise<boolean> {
  try {
    const result = await runCommand("codex", ["--version"], {
      cwd: process.cwd(),
      timeoutMs: 20_000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function ensureLocalLiveBaseDir(): string {
  const baseDir = path.join(process.cwd(), ".tmp-live");
  fs.mkdirSync(baseDir, { recursive: true });
  return baseDir;
}

const CAN_RUN_CODEX = LIVE_TESTS_ENABLED ? await canRunCodex() : false;

if (LIVE_TESTS_ENABLED && !CAN_RUN_CODEX) {
  console.info(
    "[quicksort-coding-agent-live] suite skipped until setup is complete: codex CLI is not available",
  );
}

describeIf(LIVE_TESTS_ENABLED && CAN_RUN_CODEX)(
  "Live: quicksort coding agent journey",
  () => {
    let runtime: AgentRuntime;
    let cleanupRuntime: (() => Promise<void>) | null = null;
    let service: PTYService;
    let workdir = "";

    beforeAll(async () => {
      const setup = await createRealTestRuntime({
        characterName: "QuicksortCodingAgentLive",
      });
      runtime = setup.runtime;
      cleanupRuntime = setup.cleanup;
      service = await PTYService.start(runtime as IAgentRuntime);
      (runtime.services as Map<string, unknown[]>).set("PTY_SERVICE", [
        service,
      ]);
      workdir = fs.mkdtempSync(
        path.join(ensureLocalLiveBaseDir(), "eliza-quicksort-coding-agent-"),
      );
    }, 180_000);

    afterAll(async () => {
      try {
        await service?.stop();
      } catch {
        // Runtime cleanup is the final fallback.
      }
      if (cleanupRuntime) {
        await cleanupRuntime();
      }
      if (workdir && !KEEP_ARTIFACTS) {
        fs.rmSync(workdir, { recursive: true, force: true });
      }
    }, 180_000);

    it(
      "uses Codex to implement quicksort and produces a runnable sorter",
      async () => {
        const [preflight] = await service.checkAvailableAgents(["codex"]);
        expect(preflight?.installed).toBe(true);

        const fileName = "quicksort.ts";
        const filePath = path.join(workdir, fileName);
        const sentinel = "LIVE_QUICKSORT_DONE";

        const spawnResult = await spawnAgentAction.handler(
          runtime as IAgentRuntime,
          createMessage({
            agentType: "codex",
            workdir,
            task:
              `Create ${fileName} in the current directory. ` +
              "Export a TypeScript function named quickSort that accepts number[] and returns a new sorted array in ascending order using the quicksort algorithm. " +
              "Do not mutate the input array. " +
              "After writing the file, print exactly " +
              `"${sentinel}". ` +
              "Do not ask follow-up questions.",
          }) as never,
          undefined,
          {},
          undefined,
        );

        expect(spawnResult?.success).toBe(true);
        expect(typeof spawnResult?.data?.sessionId).toBe("string");
        const sessionId = String(spawnResult?.data?.sessionId ?? "");
        expect(sessionId.length).toBeGreaterThan(0);

        await waitFor(
          async () => {
            const session = service.getSession(sessionId);
            if (!session) {
              throw new Error("session disappeared before completion");
            }
            const output = cleanForChat(
              await service.getSessionOutput(sessionId),
            );
            if (session.status === "error" || session.status === "stopped") {
              if (!fs.existsSync(filePath)) {
                throw new Error(
                  `session ended with status ${session.status}. Output: ${output.slice(-800)}`,
                );
              }
            }
            if (!fs.existsSync(filePath)) {
              return false;
            }
            const fileText = fs.readFileSync(filePath, "utf8");
            if (!fileText.includes("quickSort")) {
              return false;
            }
            return output.includes(sentinel);
          },
          6 * 60_000,
          3_000,
        );

        const validation = await runCommand(
          "bun",
          [
            "-e",
            [
              `import { quickSort } from "./${fileName}";`,
              "const sample = [5, 3, 8, 1, 2, 1];",
              "const sorted = quickSort(sample);",
              'if (JSON.stringify(sample) !== JSON.stringify([5,3,8,1,2,1])) throw new Error("input mutated");',
              "if (JSON.stringify(sorted) !== JSON.stringify([1,1,2,3,5,8])) throw new Error(`unexpected sort output: ${JSON.stringify(sorted)}`);",
              "console.log(JSON.stringify(sorted));",
            ].join(" "),
          ],
          {
            cwd: workdir,
            timeoutMs: 60_000,
          },
        );

        expect(validation.exitCode).toBe(
          0,
          `Expected bun validation to pass.\nstdout=${validation.stdout}\nstderr=${validation.stderr}`,
        );
        expect(validation.stdout).toContain("[1,1,2,3,5,8]");
      },
      8 * 60_000,
    );

    it(
      "uses Codex to draft a short markdown document from a natural-language request",
      async () => {
        const [preflight] = await service.checkAvailableAgents(["codex"]);
        expect(preflight?.installed).toBe(true);

        const fileName = "morning-news-brief.md";
        const filePath = path.join(workdir, fileName);
        const sentinel = "LIVE_DRAFT_DONE";

        const spawnResult = await spawnAgentAction.handler(
          runtime as IAgentRuntime,
          createMessage({
            agentType: "codex",
            workdir,
            task:
              `Create ${fileName} in the current directory. ` +
              "Write a concise markdown document for a user-facing feature brief about a recurring 9am heartbeat that summarizes financial and international news every morning. " +
              "Include a title, a one-sentence summary, and exactly three bullet points covering what it does, when it runs, and why it is useful. " +
              `After writing the file, print exactly "${sentinel}". ` +
              "Do not ask follow-up questions.",
          }) as never,
          undefined,
          {},
          undefined,
        );

        expect(spawnResult?.success).toBe(true);
        expect(typeof spawnResult?.data?.sessionId).toBe("string");
        const sessionId = String(spawnResult?.data?.sessionId ?? "");
        expect(sessionId.length).toBeGreaterThan(0);

        await waitFor(
          async () => {
            const session = service.getSession(sessionId);
            if (!session) {
              throw new Error("session disappeared before completion");
            }
            const output = cleanForChat(
              await service.getSessionOutput(sessionId),
            );
            if (session.status === "error" || session.status === "stopped") {
              if (!fs.existsSync(filePath)) {
                throw new Error(
                  `session ended with status ${session.status}. Output: ${output.slice(-800)}`,
                );
              }
            }
            if (!fs.existsSync(filePath)) {
              return false;
            }
            const fileText = fs.readFileSync(filePath, "utf8");
            if (!fileText.includes("#")) {
              return false;
            }
            return output.includes(sentinel);
          },
          6 * 60_000,
          3_000,
        );

        const fileText = fs.readFileSync(filePath, "utf8");
        expect(fileText).toContain("#");
        expect(fileText).toMatch(/9(?::00)?\s*a\.?m\.?/i);
        expect(fileText.toLowerCase()).toContain("financial");
        expect(fileText.toLowerCase()).toContain("international");
        expect(fileText.toLowerCase()).toContain("heartbeat");
        expect((fileText.match(/^- /gm) ?? []).length).toBe(3);
      },
      8 * 60_000,
    );
  },
);
