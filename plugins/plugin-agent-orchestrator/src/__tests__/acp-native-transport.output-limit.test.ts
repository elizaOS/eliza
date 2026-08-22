/**
 * Native-transport bounded-output contracts: the terminal complete-capture
 * limit is a fail-closed REJECT whose typed refusal names the durably
 * persisted head (never a partial capture posing as the result), and the
 * agent-stderr accumulator persists the complete pre-slice text before
 * keeping a marked tail. Real child processes (POSIX shell) and a real
 * temp-dir durable content store — no mocks.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendBoundedStderr,
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

describe("terminal complete-capture limit (fail-closed REJECT)", () => {
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
    // command result.
    expect(thrown?.message).toContain("complete-capture safety limit");
    expect(thrown?.message).toContain("no partial result is available");
    // The head captured before overflow is durably preserved and named.
    const sha = thrown?.message.match(/content\/([0-9a-f]{64})/)?.[1];
    expect(sha).toBeTruthy();
    const head = readAll(sha as string);
    expect(head.startsWith("aaaa")).toBe(true);
    expect(head.length).toBeGreaterThan(4_096);
  });
});

describe("appendBoundedStderr (persist-before-slice)", () => {
  it("keeps small accumulations verbatim", () => {
    expect(appendBoundedStderr("abc", "def")).toBe("abcdef");
  });

  it("persists the complete pre-slice stderr and keeps a marked byte-bounded tail", () => {
    const full = "e".repeat(20_000);
    const view = appendBoundedStderr("", full);
    expect(
      view.startsWith(
        "[agent stderr tail — full stderr: GET /api/orchestrator/content/",
      ),
    ).toBe(true);
    const sha = view.match(/content\/([0-9a-f]{64})\]/)?.[1] as string;
    expect(readAll(sha)).toBe(full);
    const tail = view.slice(view.indexOf("]\n") + 2);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(16_384);
    expect(full.endsWith(tail)).toBe(true);
  });

  it("chains overflow records so successive persists cover the whole stream", () => {
    const first = appendBoundedStderr("", "A".repeat(20_000));
    const firstSha = first.match(/content\/([0-9a-f]{64})\]/)?.[1] as string;
    const second = appendBoundedStderr(first, "B".repeat(20_000));
    const secondSha = second.match(/content\/([0-9a-f]{64})\]/)?.[1] as string;
    expect(secondSha).not.toBe(firstSha);
    // The second record embeds the first record's marker — a resolvable chain.
    expect(readAll(secondSha)).toContain(`content/${firstSha}]`);
  });
});

describe("appendBoundedStderr durable persist failure (no silent head drop)", () => {
  it("retains the COMPLETE accumulation with one declared fault when the persist fails", () => {
    // Point the trajectory dir at a regular FILE so persistDurableContent's
    // mkdir fails with ENOTDIR — a real store fault, not a mock.
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "occupied", "utf8");
    process.env.ELIZA_TRAJECTORY_DIR = blocker;

    const first = appendBoundedStderr("", "A".repeat(20_000)); // > 16 KiB tail
    expect(first.startsWith("[agent stderr durable persist failed")).toBe(true);
    expect(first.endsWith("A".repeat(20_000))).toBe(true);
    expect(first).not.toContain("GET /api/orchestrator/content/");

    // A second failing append keeps everything and does NOT stack markers.
    const second = appendBoundedStderr(first, "B".repeat(2_000));
    expect(second.endsWith(`${"A".repeat(20_000)}${"B".repeat(2_000)}`)).toBe(
      true,
    );
    expect(second.match(/\[agent stderr durable persist failed/g)?.length).toBe(
      1,
    );
  });
});
