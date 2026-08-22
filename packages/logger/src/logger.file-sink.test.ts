/**
 * Integration tests for the optional logger file sinks using the real logger
 * module and real node:fs files in isolated Bun subprocesses. The harness only
 * intercepts write/open seams to reproduce partial and transient failures.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const temporaryDirectories: string[] = [];

function makeOutputPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "eliza-logger-file-sink-"));
  temporaryDirectories.push(directory);
  return join(directory, "output.log");
}

function runLoggerScenario(
  outputPath: string,
  scenario: string,
): Record<string, unknown> {
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    ${scenario}
  `;
  const result = spawnSync("bun", ["-e", script], {
    cwd: repoRoot,
    env: { ...process.env, LOG_FILE: outputPath },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const lastLine = result.stdout.trim().split("\n").at(-1);
  expect(lastLine).toBeDefined();
  return JSON.parse(lastLine ?? "{}") as Record<string, unknown>;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("lossless logger file sinks", () => {
  it("completes partial writes instead of dropping the unwritten suffix", () => {
    const outputPath = makeOutputPath();
    const result = runLoggerScenario(
      outputPath,
      `
        const originalWriteSync = fs.writeSync.bind(fs);
        let targetFd;
        let partialWrites = 0;
        fs.writeSync = ((fd, data, ...args) => {
          const offset = typeof data === "string" ? 0 : (args[0] ?? 0);
          const length = typeof data === "string" ? data.length : (args[1] ?? data.byteLength - offset);
          const text = typeof data === "string"
            ? data
            : new TextDecoder().decode(data.subarray(offset, offset + length));
          if (targetFd === undefined && text.includes("partial-write-marker")) targetFd = fd;
          if (fd === targetFd) {
            partialWrites += 1;
            if (typeof data === "string") {
              const prefix = data.slice(0, data.indexOf("partial-write-marker") + 7);
              return originalWriteSync(fd, prefix);
            }
            const chunkLength = Math.min(7, length);
            return originalWriteSync(fd, data, offset, chunkLength);
          }
          return originalWriteSync(fd, data, ...args);
        });
        const { createLogger } = await import("./packages/logger/src/logger.ts");
        createLogger({ level: "info" }).info("partial-write-marker-UNWRITTEN-SUFFIX");
        fs.writeSync = originalWriteSync;
        const persisted = fs.readFileSync(process.env.LOG_FILE, "utf8");
        console.log(JSON.stringify({ partialWrites, persisted }));
      `,
    );

    expect(result.partialWrites).toBeGreaterThan(1);
    expect(result.persisted).toContain("partial-write-marker-UNWRITTEN-SUFFIX");
  });

  it("recovers a transient open failure and preserves record order", () => {
    const outputPath = makeOutputPath();
    const result = runLoggerScenario(
      outputPath,
      `
        const originalOpenSync = fs.openSync.bind(fs);
        let failedOnce = false;
        fs.openSync = ((target, ...args) => {
          if (!failedOnce && target === process.env.LOG_FILE) {
            failedOnce = true;
            throw new Error("synthetic transient open failure");
          }
          return originalOpenSync(target, ...args);
        });
        const { createLogger } = await import("./packages/logger/src/logger.ts");
        const logger = createLogger({ level: "info" });
        logger.info("first-record-must-survive");
        fs.openSync = originalOpenSync;
        logger.info("second-record-triggers-recovery");
        const persisted = fs.readFileSync(process.env.LOG_FILE, "utf8");
        console.log(JSON.stringify({ failedOnce, persisted }));
      `,
    );

    expect(result.failedOnce).toBe(true);
    expect(result.persisted).toContain("first-record-must-survive");
    expect(result.persisted).toContain("second-record-triggers-recovery");
    expect(
      String(result.persisted).indexOf("first-record-must-survive"),
    ).toBeLessThan(
      String(result.persisted).indexOf("second-record-triggers-recovery"),
    );
  });

  it("retries a failed prompt write before the correlated response", () => {
    const outputPath = makeOutputPath();
    const result = runLoggerScenario(
      outputPath,
      `
        const originalWriteSync = fs.writeSync.bind(fs);
        let failedOnce = false;
        fs.writeSync = ((fd, data, ...args) => {
          const offset = typeof data === "string" ? 0 : (args[0] ?? 0);
          const length = typeof data === "string" ? data.length : (args[1] ?? data.byteLength - offset);
          const text = typeof data === "string"
            ? data
            : new TextDecoder().decode(data.subarray(offset, offset + length));
          if (!failedOnce && text.includes("queued-prompt-must-survive")) {
            failedOnce = true;
            throw new Error("synthetic transient write failure");
          }
          return originalWriteSync(fd, data, ...args);
        });
        const { logPrompt, logResponse } = await import("./packages/logger/src/logger.ts");
        const promptSlug = logPrompt("text", "queued-prompt-must-survive");
        fs.writeSync = originalWriteSync;
        logResponse("text", "correlated-response", { promptSlug });
        const promptPath = path.join(path.dirname(process.env.LOG_FILE), "prompts.log");
        const persisted = fs.readFileSync(promptPath, "utf8");
        console.log(JSON.stringify({ failedOnce, persisted }));
      `,
    );

    expect(result.failedOnce).toBe(true);
    expect(result.persisted).toContain("queued-prompt-must-survive");
    expect(result.persisted).toContain("correlated-response");
    expect(
      String(result.persisted).indexOf("queued-prompt-must-survive"),
    ).toBeLessThan(String(result.persisted).indexOf("correlated-response"));
  });

  it("persists complete prompt and chat instrumentation content", () => {
    const outputPath = makeOutputPath();
    const result = runLoggerScenario(
      outputPath,
      `
        const { logPrompt, logChatIn, logChatOut } = await import("./packages/logger/src/logger.ts");
        const promptTail = "PROMPT-TAIL-MUST-SURVIVE";
        const prompt = "p".repeat(100_001) + promptTail;
        const chatTail = "CHAT-TAIL-MUST-SURVIVE";
        const chatText = "  first line\\nsecond\\tline  " + "c".repeat(220) + chatTail;
        const reasoningTail = "REASONING-TAIL-MUST-SURVIVE";
        const reasoning = "r".repeat(90) + reasoningTail;
        logPrompt("text", prompt);
        logChatIn({
          agentName: "Eliza",
          agentId: "agent-complete",
          roomId: "room-complete-identifier",
          messageId: "message-complete-identifier",
          text: chatText,
          source: "test",
        });
        logChatOut({
          agentName: "Eliza",
          agentId: "agent-complete",
          roomId: "room-complete-identifier",
          action: "reply",
          text: chatText,
          reasoning,
        });
        const directory = path.dirname(process.env.LOG_FILE);
        console.log(JSON.stringify({
          promptLog: fs.readFileSync(path.join(directory, "prompts.log"), "utf8"),
          chatLog: fs.readFileSync(path.join(directory, "chat.log"), "utf8"),
        }));
      `,
    );

    expect(result.promptLog).toContain("PROMPT-TAIL-MUST-SURVIVE");
    expect(result.promptLog).not.toContain("[TRUNCATED");
    expect(result.chatLog).toContain("CHAT-TAIL-MUST-SURVIVE");
    expect(result.chatLog).toContain("  first line\\nsecond\\tline  ");
    expect(result.chatLog).toContain("REASONING-TAIL-MUST-SURVIVE");
    expect(result.chatLog).toContain("room-complete-identifier");
    expect(result.chatLog).toContain("message-complete-identifier");
  });
});
