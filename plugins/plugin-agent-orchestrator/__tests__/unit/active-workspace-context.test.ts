/**
 * The provider used to compute "reusable" sessions by comparing against an
 * always-empty task list, so it advertised EVERY session — including busy,
 * mid-turn ones — to the planner as idle/re-taskable (nextAction=SEND_TO_AGENT).
 * It also reported a phantom taskCount:0 + dead task/pending blocks. These
 * assert the corrected behavior: only idle ("ready") sessions are reusable.
 */

import type { Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { activeWorkspaceContextProvider } from "../../src/providers/active-workspace-context.js";

function mkSession(id: string, name: string, status: string) {
  return {
    id,
    name,
    agentType: "opencode",
    status,
    workdir: `/work/${id}`,
    metadata: {},
  };
}

function runtimeWithSessions(sessions: unknown[]) {
  const acp = { listSessions: () => sessions };
  return {
    getService: (t: string) =>
      t === "ACP_SERVICE" || t === "ACP_SUBPROCESS_SERVICE" ? acp : undefined,
    getSetting: () => undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as never;
}

describe("activeWorkspaceContextProvider reusable sessions", () => {
  it("advertises only idle (ready) sessions as reusable, never busy mid-turn ones", async () => {
    const runtime = runtimeWithSessions([
      mkSession("s-ready", "Ada", "ready"),
      mkSession("s-busy", "Bo", "busy"),
      mkSession("s-tool", "Cy", "tool_running"),
    ]);
    const res = await activeWorkspaceContextProvider.get(
      runtime,
      {} as Memory,
      {} as State,
    );
    const text = res.text ?? "";
    const lines = text.split("\n");
    const idx = lines.findIndex((l) => l.startsWith("reusableAgents["));
    expect(idx).toBeGreaterThanOrEqual(0);
    // Exactly ONE reusable session (the ready one), not all three.
    expect(lines[idx]).toContain("reusableAgents[1]");
    const entry = lines[idx + 1] ?? "";
    expect(entry).toContain("Ada");
    expect(entry).toContain("SEND_TO_AGENT");
    // The busy / tool_running sessions are NOT offered as reusable.
    expect(entry).not.toContain("Bo");
    expect(entry).not.toContain("Cy");
  });

  it("no longer reports a phantom taskCount / tasks block", async () => {
    const runtime = runtimeWithSessions([mkSession("s1", "Ada", "ready")]);
    const res = await activeWorkspaceContextProvider.get(
      runtime,
      {} as Memory,
      {} as State,
    );
    const text = res.text ?? "";
    expect(text).not.toContain("taskCount:");
    expect(text).not.toMatch(/^tasks\[/m);
    // data.currentTasks is honestly empty (task state lives in the task service).
    const data = res.data as { currentTasks?: unknown[] } | undefined;
    expect(data?.currentTasks).toEqual([]);
  });

  it("has no reusable agents when the only session is busy", async () => {
    const runtime = runtimeWithSessions([mkSession("s-busy", "Bo", "busy")]);
    const res = await activeWorkspaceContextProvider.get(
      runtime,
      {} as Memory,
      {} as State,
    );
    expect(res.text ?? "").not.toContain("reusableAgents[");
  });
});
