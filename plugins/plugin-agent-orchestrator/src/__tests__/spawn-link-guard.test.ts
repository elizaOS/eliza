/**
 * Pre-spawn intent gate: TASKS_SPAWN_AGENT / TASKS_CREATE must refuse — BEFORE
 * any ACP session exists — when the task prompt is empty or derived only from
 * a shared link (bare URL + connector embed preview, no explicit instruction
 * in the user's own words). Live incident: a bare Discord URL whose embed
 * title contained workflow-ish words spawned a coding sub-agent with
 * body/instruction/input all empty; the doomed session dead-ended and the
 * user saw "runtime step failed". Deterministic — drives the REAL tasksAction
 * handler against a fake ACP service; no live model.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { tasksAction } from "../actions/tasks.ts";

const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MSG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";

/** The exact processed-content shape Discord produces for a shared link with
 * a rendered preview: the raw URL plus the connector-appended embed block. */
const LINK_SHARE_TEXT = [
  "https://claude.ai/public/artifacts/abc123",
  "Embed #1:",
  "  Title:how the agent decides to message people",
  "  Description:(none)",
].join("\n");

function makeFakeAcp() {
  const spawnSession = vi.fn(async (opts: Record<string, unknown>) => ({
    sessionId: "session-1",
    agentType: (opts.agentType as string) ?? "codex",
    workdir: (opts.workdir as string) ?? "/tmp/spawn-test",
    status: "running",
  }));
  const service = {
    spawnSession,
    getSession: vi.fn(async () => undefined),
    getSessions: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    stopSession: vi.fn(async () => undefined),
    resolveAgentType: vi.fn(async () => "codex"),
    onSessionEvent: vi.fn(() => () => undefined),
  };
  return { service, spawnSession };
}

function makeRuntime(acp: ReturnType<typeof makeFakeAcp>["service"]) {
  return {
    agentId: AGENT_ID,
    character: { name: "Tester" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    getService: (type: string) => {
      if (type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE")
        return acp;
      return undefined;
    },
    reportError: vi.fn(),
    emitEvent: vi.fn(async () => undefined),
    useModel: vi.fn(async () => "{}"),
  } as unknown as IAgentRuntime;
}

function messageWithText(text: string): Memory {
  return {
    id: MSG,
    entityId: USER,
    roomId: ROOM,
    agentId: AGENT_ID,
    content: { text, source: "discord" },
    createdAt: 1,
  } as unknown as Memory;
}

async function runOp(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: Record<string, unknown>,
) {
  const result = await tasksAction.handler(
    runtime,
    message,
    undefined as unknown as State,
    { parameters },
    undefined,
  );
  if (!result) throw new Error("handler returned no result");
  return result;
}

describe("TASKS spawn gate: bare link shares never spawn", () => {
  it("spawn_agent with a link-share message and a derived-only task refuses pre-spawn", async () => {
    const { service, spawnSession } = makeFakeAcp();
    const runtime = makeRuntime(service);
    const result = await runOp(runtime, messageWithText(LINK_SHARE_TEXT), {
      action: "spawn_agent",
      agentType: "elizaos",
      // The model derived this from the embed title — not a user instruction.
      task: "agent-messaging-fix",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("LINK_SHARE_NOT_A_TASK");
    // The refusal must point the planner at the web-read light path.
    expect(String(result.text)).toMatch(/WEB_FETCH/);
    expect(String(result.text)).toMatch(/embed/i);
    // FAIL FAST: no ACP session may exist for a refused spawn.
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("create with a link-share message refuses pre-spawn too", async () => {
    const { service, spawnSession } = makeFakeAcp();
    const runtime = makeRuntime(service);
    const result = await runOp(runtime, messageWithText(LINK_SHARE_TEXT), {
      action: "create",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("LINK_SHARE_NOT_A_TASK");
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("an explicit build instruction that includes a URL still spawns", async () => {
    const { service, spawnSession } = makeFakeAcp();
    const runtime = makeRuntime(service);
    const result = await runOp(
      runtime,
      messageWithText(
        "build me a landing page based on this https://example.com/design",
      ),
      {
        action: "spawn_agent",
        agentType: "elizaos",
        task: "build a landing page modeled on https://example.com/design",
      },
    );

    expect(result.success).toBe(true);
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });
});

describe("TASKS spawn gate: empty task prompts refuse pre-spawn", () => {
  it("spawn_agent with no task and an empty message refuses before any session exists", async () => {
    const { service, spawnSession } = makeFakeAcp();
    const runtime = makeRuntime(service);
    const result = await runOp(runtime, messageWithText("   "), {
      action: "spawn_agent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("EMPTY_TASK_PROMPT");
    // Clear, planner-usable refusal — not a spawned-then-failed doomed agent.
    expect(String(result.text)).toMatch(/empty/i);
    expect(spawnSession).not.toHaveBeenCalled();
  });
});
