/**
 * Completeness regressions for the ACTIVE_SUB_AGENTS provider surface
 * (prompt integrity: complete model context, no "most recent" windows):
 *  - the recently-finished section lists EVERY lane finished inside its
 *    30-minute window, newest-first, with no elision line and no lane cap;
 *  - describeFinishedWorkdir lists EVERY visible top-level file, sorted,
 *    with the exact total count — no "+N more" omission;
 *  - active-session rows carry the FULL workdir in the data payload while the
 *    text line stays the marked `workdir=…{tail}` preview.
 * Real provider + real fs for the finished workdir; fake ACP session list.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeSubAgentsProvider } from "../providers/active-sub-agents.ts";

const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  vi.restoreAllMocks();
});

function session(
  id: string,
  status: string,
  workdir: string,
  lastActivityAt: Date,
): Record<string, unknown> {
  return {
    id,
    agentType: "codex",
    name: `agent-${id}`,
    workdir,
    status,
    createdAt: lastActivityAt,
    lastActivityAt,
    metadata: { roomId: ROOM, label: `lane-${id}` },
  };
}

function makeRuntime(sessions: Record<string, unknown>[]): IAgentRuntime {
  const acp = {
    listSessions: async () => sessions,
  };
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    character: { name: "Tester" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    reportError: vi.fn(),
    getService: (type: string) => {
      if (type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE")
        return acp;
      return null;
    },
  } as unknown as IAgentRuntime;
}

async function getProvider(sessions: Record<string, unknown>[]) {
  return activeSubAgentsProvider.get(
    makeRuntime(sessions),
    {} as Memory,
    {} as State,
  );
}

describe("recently-finished section completeness", () => {
  it("lists every finished lane in the window with no elision", async () => {
    const now = new Date();
    const sessions = Array.from({ length: 5 }, (_, i) =>
      session(`done-${i}`, "completed", "/nonexistent/gone", now),
    );
    const result = await getProvider(sessions);
    expect(result.text).toContain("## Recently finished sub-agent work");
    for (let i = 0; i < 5; i++) {
      expect(result.text).toContain(`sessionId=done-${i} `);
    }
    expect(result.text).not.toContain("more finished lane(s)");
  });

  it('sorts the window newest-first so "recent" is true', async () => {
    const now = Date.now();
    const sessions = [
      session(
        "done-old",
        "completed",
        "/nonexistent/x",
        new Date(now - 60_000),
      ),
      session("done-new", "completed", "/nonexistent/x", new Date(now)),
      session(
        "done-mid",
        "completed",
        "/nonexistent/x",
        new Date(now - 30_000),
      ),
    ];
    const result = await getProvider(sessions);
    const newAt = result.text.indexOf("sessionId=done-new");
    const midAt = result.text.indexOf("sessionId=done-mid");
    const oldAt = result.text.indexOf("sessionId=done-old");
    expect(newAt).toBeGreaterThan(-1);
    expect(newAt).toBeLessThan(midAt);
    expect(midAt).toBeLessThan(oldAt);
  });

  it("keeps lanes older than the window out (TASKS_HISTORY owns them)", async () => {
    const now = Date.now();
    const sessions = [
      session("done-fresh", "completed", "/nonexistent/x", new Date(now)),
      session(
        "done-stale",
        "completed",
        "/nonexistent/x",
        new Date(now - 31 * 60_000),
      ),
    ];
    const result = await getProvider(sessions);
    expect(result.text).toContain("sessionId=done-fresh");
    expect(result.text).not.toContain("sessionId=done-stale");
    expect(result.text).toContain("call TASKS_HISTORY");
  });
});

describe("finished-workdir file listing", () => {
  it("lists every visible file, sorted, with the exact total count", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "finished-workdir-"));
    cleanups.push(() => fs.rmSync(workdir, { recursive: true, force: true }));
    // Deliberately created out of order; the listing must be sorted.
    for (const name of ["f.txt", "b.txt", "d.txt", "a.txt", "e.txt", "c.txt"]) {
      fs.writeFileSync(path.join(workdir, name), "x", "utf8");
    }
    const result = await getProvider([
      session("done-files", "completed", workdir, new Date()),
    ]);
    expect(result.text).toContain(
      `workdir=${workdir} files(6)=a.txt,b.txt,c.txt,d.txt,e.txt,f.txt`,
    );
    expect(result.text).not.toContain("more in this workdir");
  });
});

describe("active-session workdir payload", () => {
  it("carries the FULL workdir in data while the text keeps the marked tail preview", async () => {
    const workdir = "/home/user/projects/deep/nested/app-dir";
    const result = await getProvider([
      session("live-1", "running", workdir, new Date()),
    ]);
    const rows = (result.data as { sessions: Array<Record<string, unknown>> })
      .sessions;
    expect(rows).toHaveLength(1);
    expect(rows[0].workdir).toBe(workdir);
    expect(rows[0].workdirTail).toBe("nested/app-dir");
    expect(result.text).toContain("workdir=…nested/app-dir");
  });
});
