/**
 * Cap-disposition regressions for the ACTIVE_SUB_AGENTS provider surface:
 *  - the recently-finished section names its elision explicitly ("…and N
 *    more") with TASKS_HISTORY as the durable handle instead of silently
 *    hiding the 4th+ finished lane;
 *  - describeFinishedWorkdir sorts the listing (deterministic preview) and
 *    names the omission ("+N more") instead of an arbitrary readdir-order
 *    first four;
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

describe("recently-finished section elision handle", () => {
  it("names the elided lanes and points at TASKS_HISTORY", async () => {
    const now = new Date();
    const sessions = Array.from({ length: 5 }, (_, i) =>
      session(`done-${i}`, "completed", "/nonexistent/gone", now),
    );
    const result = await getProvider(sessions);
    // Only the newest RECENT_COMPLETED_MAX (3) lanes are listed…
    expect(result.text).toContain("## Recently finished sub-agent work");
    // …and the bound is reference-bearing, never silent.
    expect(result.text).toContain(
      "…and 2 more finished lane(s) in this window — call TASKS_HISTORY for the complete list.",
    );
  });

  it("emits no elision line when everything fits", async () => {
    const now = new Date();
    const sessions = [session("done-solo", "completed", "/nonexistent/x", now)];
    const result = await getProvider(sessions);
    expect(result.text).not.toContain("more finished lane(s)");
  });
});

describe("finished-workdir file preview", () => {
  it("sorts the listing and names the omission with +N more", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "finished-workdir-"));
    cleanups.push(() => fs.rmSync(workdir, { recursive: true, force: true }));
    // Deliberately created out of order; the preview must be sorted.
    for (const name of ["f.txt", "b.txt", "d.txt", "a.txt", "e.txt", "c.txt"]) {
      fs.writeFileSync(path.join(workdir, name), "x", "utf8");
    }
    const result = await getProvider([
      session("done-files", "completed", workdir, new Date()),
    ]);
    expect(result.text).toContain(
      `workdir=${workdir} files=a.txt,b.txt,c.txt,d.txt (+2 more in this workdir)`,
    );
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
