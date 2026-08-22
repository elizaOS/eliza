/**
 * Durable-projection contracts of AcpService's bounded output surfaces
 * (prompt-integrity regression coverage): the 12,000-char terminal tool-output
 * envelope persists the complete value and carries the content resolver; the
 * stderr cap persists before slicing; the session/turn output windows and the
 * stopped-event payload report ring evictions with the durable continuation
 * marker instead of posing as complete. Real service instance with an
 * in-memory store and a real temp-dir durable content store — no mocks.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AcpService,
  capStderr,
  captureTerminalToolOutput,
} from "../services/acp-service.ts";
import { readDurableContent } from "../services/durable-content-store.js";
import { InMemorySessionStore } from "../services/session-store.ts";
import { appendSubagentStdout } from "../services/subagent-stdout-log.js";

let dir: string;
let savedDir: string | undefined;
let savedLogging: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-projection-"));
  savedDir = process.env.ELIZA_TRAJECTORY_DIR;
  savedLogging = process.env.ELIZA_TRAJECTORY_LOGGING;
  process.env.ELIZA_TRAJECTORY_DIR = dir;
  process.env.ELIZA_TRAJECTORY_LOGGING = "1";
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
  else process.env.ELIZA_TRAJECTORY_DIR = savedDir;
  if (savedLogging === undefined) delete process.env.ELIZA_TRAJECTORY_LOGGING;
  else process.env.ELIZA_TRAJECTORY_LOGGING = savedLogging;
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeRuntime() {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    character: { name: "Tester" },
    getSetting: () => undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getService: () => null,
    reportError() {},
  };
}

type Internals = {
  outputBuffers: Map<string, string[]>;
  outputBufferDrops: Map<string, number>;
  turnOutputBuffers: Map<string, string[]>;
  turnOutputBufferDrops: Map<string, number>;
  persistedStdoutSessions: Set<string>;
  appendOutput: (sessionId: string, text: string) => void;
  lastOutput: (sessionId: string) => string;
};

function makeService(): { svc: AcpService; internals: Internals } {
  const svc = new AcpService(makeRuntime() as never, {
    store: new InMemorySessionStore(),
  });
  return { svc, internals: svc as unknown as Internals };
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

describe("captureTerminalToolOutput (12k envelope projection)", () => {
  it("persists oversized tool output whole and emits a resolver-bearing head", () => {
    const full = "T".repeat(30_000);
    const captured = captureTerminalToolOutput(
      { id: "tool-1", title: "bash" },
      full,
      new Set<string>(),
    );
    expect(captured).toBeDefined();
    expect(captured).toContain("[tool output: bash]");
    expect(captured).toContain("[/tool output]");
    // The bare, unresolvable truncation marker is gone.
    expect(captured).not.toContain("[tool output truncated]");
    const match = captured?.match(
      /GET \/api\/orchestrator\/content\/([0-9a-f]{64})/,
    );
    expect(match).toBeTruthy();
    // The complete output is recoverable through the named resolver.
    expect(readAll(match?.[1] as string)).toBe(full);
    // The projection body respects the envelope budget (head + marker).
    const lines = captured?.split("\n") ?? [];
    const body = lines.slice(1, -1).join("\n");
    expect(body.length).toBeLessThanOrEqual(12_000);
    expect(body.startsWith("TTTT")).toBe(true);
  });

  it("passes within-budget output through whole, with no reference", () => {
    const captured = captureTerminalToolOutput(
      { id: "tool-2", title: "echo" },
      "hello world",
      new Set<string>(),
    );
    expect(captured).toContain("hello world");
    expect(captured).not.toContain("GET /api/orchestrator/content/");
  });
});

describe("capStderr (persist-before-slice)", () => {
  it("persists the complete pre-slice stderr and keeps a marked byte-bounded tail", () => {
    const full = `${"H".repeat(40_000)}${"T".repeat(40_000)}`; // > 64 KiB
    const view = capStderr(full);
    expect(
      view.startsWith(
        "[stderr tail — full stderr: GET /api/orchestrator/content/",
      ),
    ).toBe(true);
    const sha = view.match(/content\/([0-9a-f]{64})\]/)?.[1] as string;
    expect(readAll(sha)).toBe(full);
    const tail = view.slice(view.indexOf("]\n") + 2);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(full.endsWith(tail)).toBe(true);
  });

  it("chains overflow records so successive persists cover the whole stream", () => {
    const first = capStderr("A".repeat(70_000));
    const firstSha = first.match(/content\/([0-9a-f]{64})\]/)?.[1] as string;
    const second = capStderr(`${first}${"B".repeat(70_000)}`);
    const secondSha = second.match(/content\/([0-9a-f]{64})\]/)?.[1] as string;
    expect(secondSha).not.toBe(firstSha);
    // The second record embeds the first record's marker — a resolvable chain.
    expect(readAll(secondSha)).toContain(`content/${firstSha}]`);
  });

  it("returns small stderr verbatim", () => {
    expect(capStderr("small stderr")).toBe("small stderr");
  });
});

describe("AcpService session output windows", () => {
  it("marks a partial in-memory window with the continuation resolver", async () => {
    const { svc, internals } = makeService();
    internals.outputBuffers.set("s1", ["a\n", "b\n", "c\n"]);
    // A complete read carries no marker.
    expect(await svc.getSessionOutput("s1", 10)).toBe("a\nb\nc\n");
    // A windowed read names the omission and the recovery state.
    const windowed = await svc.getSessionOutput("s1", 2);
    expect(windowed).toContain(
      "[session output tail: last 2 of 3 captured chunks",
    );
    expect(windowed).toContain("b\nc\n");
    expect(windowed).toContain("trajectory recording disabled");
    // With the durable tee live, the marker names the resolver route.
    internals.persistedStdoutSessions.add("s1");
    const withRef = await svc.getSessionOutput("s1", 2);
    expect(withRef).toContain("GET /api/coding-agents/s1/output?offset=0");
    expect(withRef).toContain("acpx-session-output:s1");
  });

  it("counts ring evictions and reports them on every read surface", async () => {
    const { svc, internals } = makeService();
    internals.turnOutputBuffers.set("s2", []);
    for (let i = 0; i < 2_050; i++) internals.appendOutput("s2", `${i}\n`);
    expect(internals.outputBuffers.get("s2")?.length).toBe(2_000);
    expect(internals.outputBufferDrops.get("s2")).toBe(50);
    expect(internals.turnOutputBufferDrops.get("s2")).toBe(50);

    const output = await svc.getSessionOutput("s2", 5_000);
    expect(output).toContain("50 oldest evicted from the in-memory ring");

    const turn = await svc.getSessionTurnOutput("s2", 5_000);
    expect(turn).toContain(
      "[turn output tail: last 2000 of 2050 captured chunks",
    );

    // The stopped-event `response` payload is reference-bearing too.
    expect(internals.lastOutput("s2")).toContain("50 oldest evicted");
  });

  it("keeps global chunk offsets stable across ring eviction in the window accessor", async () => {
    const { svc, internals } = makeService();
    internals.outputBuffers.set("s3", ["c", "d", "e"]);
    internals.outputBufferDrops.set("s3", 2); // chunks 0-1 evicted
    const window = await svc.getSessionOutputWindow("s3", {
      offset: 0,
      limit: 10,
    });
    expect(window).toMatchObject({
      source: "memory",
      // Clamped to what memory still holds — reported, never silent.
      offset: 2,
      totalChunks: 5,
      hasMore: false,
      rotated: true,
    });
    expect(window?.text).toBe("cde");
  });

  it("propagates the durable window contract for closed sessions instead of stripping it", async () => {
    const { svc } = makeService();
    for (const chunk of ["0", "1", "2", "3", "4"]) {
      await appendSubagentStdout("s4", chunk);
    }
    // No in-memory buffer → durable fallback. Complete read: no marker.
    expect(await svc.getSessionOutput("s4", 10)).toBe("01234");
    // Tail window: the continuation contract reaches the caller.
    const tail = await svc.getSessionOutput("s4", 2);
    expect(tail).toContain(
      "[session output window from durable log: chunks from 3 of 5",
    );
    expect(tail).toContain("GET /api/coding-agents/s4/output?offset=0");
    expect(tail).toContain("34");
    // The structured accessor serves the durable source directly.
    const window = await svc.getSessionOutputWindow("s4", {
      offset: 1,
      limit: 2,
    });
    expect(window).toMatchObject({
      source: "durable",
      offset: 1,
      limit: 2,
      totalChunks: 5,
      hasMore: true,
    });
    expect(window?.text).toBe("12");
  });
});

describe("durable persist failure honesty (no silent partial views)", () => {
  /** Point the trajectory dir at a regular FILE so persistDurableContent's
   *  mkdir fails with ENOTDIR — a real store fault, not a mock. */
  function breakDurableStore(): void {
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "occupied", "utf8");
    process.env.ELIZA_TRAJECTORY_DIR = blocker;
  }

  it("captureTerminalToolOutput emits the COMPLETE output inline when the persist fails", () => {
    breakDurableStore();
    const full = "F".repeat(30_000);
    const captured = captureTerminalToolOutput(
      { id: "tool-broken-store", title: "bash" },
      full,
      new Set<string>(),
    );
    expect(captured).toBeDefined();
    // Nothing dropped: the whole 30k-char output is present.
    expect(captured).toContain(full);
    // The fault is declared, and no truncation marker poses as a bounded view.
    expect(captured).toContain("durable content persist failed");
    expect(captured).not.toContain("[tool output truncated");
    expect(captured).not.toContain("GET /api/orchestrator/content/");
  });

  it("capStderr returns the COMPLETE stderr when the persist fails", () => {
    breakDurableStore();
    const full = `${"H".repeat(40_000)}${"T".repeat(40_000)}`; // > 64 KiB cap
    const view = capStderr(full);
    expect(view.startsWith("[stderr durable persist failed")).toBe(true);
    // The head is NOT dropped: the complete stderr follows the declaration.
    expect(view.endsWith(full)).toBe(true);
    expect(view).not.toContain("GET /api/orchestrator/content/");
  });
});

describe("getSessionOutput durable-read fault (typed unavailable, never '')", () => {
  it("throws ACP_SESSION_OUTPUT_UNAVAILABLE when the log exists but cannot be read", async () => {
    const { svc } = makeService();
    // A DIRECTORY at the exact log path makes readFile fail with EISDIR — a
    // real read FAULT, distinct from the ENOENT "no log" case. Pre-fix this
    // was swallowed into "", indistinguishable from "no output".
    fs.mkdirSync(path.join(dir, "subagent-stdout", "s-fault.ndjson"), {
      recursive: true,
    });
    await expect(svc.getSessionOutput("s-fault", 10)).rejects.toMatchObject({
      code: "ACP_SESSION_OUTPUT_UNAVAILABLE",
    });
    await expect(
      svc.getSessionOutputWindow("s-fault", { offset: 0, limit: 2 }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_OUTPUT_UNAVAILABLE",
    });
  });

  it("still reports genuinely absent output as empty, not as a fault", async () => {
    const { svc } = makeService();
    expect(await svc.getSessionOutput("s-none", 10)).toBe("");
    expect(await svc.getSessionOutputWindow("s-none", {})).toBeUndefined();
  });
});
