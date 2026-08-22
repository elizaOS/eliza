/**
 * Native-transport output contracts (post-rework): the terminal
 * complete-capture limit is a fail-closed typed REJECT at the ACP terminal
 * boundary — the sub-agent model receives either the complete output or an
 * explicit refusal, never a partial capture posing as the result — and the
 * agent-stderr accumulator keeps the COMPLETE text (the retired
 * persist-before-slice tail substitution is gone: failure text built from
 * this buffer is model-facing and must be complete). Real child processes
 * (POSIX shell) and a real temp-dir durable content store — no mocks.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCompleteStderr,
  NativeAcpClient,
} from "../services/acp-native-transport.js";
import { readDurableContent } from "../services/durable-content-store.js";

let dir: string;
let savedDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-terminal-"));
  savedDir = process.env.ELIZA_TRAJECTORY_DIR;
  process.env.ELIZA_TRAJECTORY_DIR = dir;
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
  else process.env.ELIZA_TRAJECTORY_DIR = savedDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

type TerminalInternals = {
  createTerminal(
    params: Record<string, unknown>,
  ): Promise<{ terminalId: string }>;
  waitForTerminalExit(
    params: Record<string, unknown>,
  ): Promise<{ exitCode: number | null }>;
  terminalOutput(params: Record<string, unknown>): {
    output: string;
    truncated: boolean;
  };
};

function makeTerminalClient(cwd: string): TerminalInternals {
  // `verifier` approves execute; the agent process itself is never started —
  // only the client-side terminal handlers are exercised.
  return new NativeAcpClient({
    command: "true",
    cwd,
    approvalPreset: "verifier",
  }) as unknown as TerminalInternals;
}

function readAll(sha: string): string {
  let out = "";
  let offset = 0;
  for (;;) {
    const window = readDurableContent(sha, { offset, limit: 8_192 });
    if (!window) throw new Error("durable record missing");
    out += window.text;
    if (!window.hasMore) break;
    offset = window.offset + Buffer.byteLength(window.text, "utf8");
  }
  return out;
}

describe("terminal complete-capture limit (fail-closed typed REJECT)", () => {
  it("returns complete output for a command within the limit", async () => {
    const client = makeTerminalClient(dir);
    const { terminalId } = await client.createTerminal({
      command: "printf hello",
    });
    await client.waitForTerminalExit({ terminalId });
    const result = client.terminalOutput({ terminalId });
    expect(result.output).toBe("hello");
    expect(result.truncated).toBe(false);
  });

  it("rejects oversized output with a typed refusal naming the persisted head", async () => {
    const client = makeTerminalClient(dir);
    const { terminalId } = await client.createTerminal({
      command: "head -c 65536 /dev/zero | tr '\\0' 'a'",
      outputByteLimit: 4_096,
    });
    await client.waitForTerminalExit({ terminalId });
    let thrown: Error | undefined;
    try {
      client.terminalOutput({ terminalId });
    } catch (err) {
      thrown = err as Error;
    }
    // The refusal is explicit — no partial capture is ever presented as the
    // command result (complete content or typed rejection, never a silent
    // partial).
    expect(thrown?.message).toContain("complete-capture safety limit");
    expect(thrown?.message).toContain("no partial result is available");
    // The head captured before overflow is durably preserved and named — a
    // diagnostic aid on the rejection path, never a substitute result.
    const sha = thrown?.message.match(/content\/([0-9a-f]{64})/)?.[1];
    expect(sha).toBeTruthy();
    const head = readAll(sha as string);
    expect(head.startsWith("aaaa")).toBe(true);
    expect(head.length).toBeGreaterThan(4_096);
  });
});

describe("appendCompleteStderr (complete accumulation, no tail substitution)", () => {
  it("keeps small accumulations verbatim", () => {
    expect(appendCompleteStderr("abc", "def")).toBe("abcdef");
  });

  it("keeps an accumulation far past the old 16 KiB tail complete and verbatim", () => {
    const full = "e".repeat(20_000);
    const accumulated = appendCompleteStderr("", full);
    expect(accumulated).toBe(full);
    expect(accumulated).not.toContain("[agent stderr tail");
    expect(accumulated).not.toContain("GET /api/orchestrator/content/");
  });

  it("keeps every byte across successive oversized appends", () => {
    const first = appendCompleteStderr("", "A".repeat(20_000));
    const second = appendCompleteStderr(first, "B".repeat(20_000));
    expect(second).toBe(`${"A".repeat(20_000)}${"B".repeat(20_000)}`);
    expect(second).not.toContain("[agent stderr");
  });

  it("stays complete when the durable store is broken (no dependency on the store)", () => {
    // Point the trajectory dir at a regular FILE so any store write would
    // fail with ENOTDIR — the accumulator must not depend on the store at
    // all: the complete text is the buffer.
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "occupied", "utf8");
    process.env.ELIZA_TRAJECTORY_DIR = blocker;

    const first = appendCompleteStderr("", "A".repeat(20_000));
    const second = appendCompleteStderr(first, "B".repeat(2_000));
    expect(second).toBe(`${"A".repeat(20_000)}${"B".repeat(2_000)}`);
    expect(second).not.toContain("durable persist failed");
    expect(second).not.toContain("GET /api/orchestrator/content/");
  });
});
