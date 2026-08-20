/**
 * Pins the LLM-voice conversion contract on the TASKS action surface:
 * Tier-S sites (refusals/guards) fire NO callback and expose structured facts
 * in data for the planner to phrase; Tier-H sites (sole-delivery
 * confirmations) route their prose through the REAL phraseForUser seam —
 * facts reach the model prompt, machine appendixes (issue URLs) stay
 * byte-identical below the model text, the canonical result text equals the
 * delivered callback text, and the per-site emission COUNT is unchanged.
 * Model failures and validation misses degrade to the factual fallbacks.
 * Harness: real handler + real CodingWorkspaceService instance with stubbed
 * provider calls; the model is a recorded useModel stub.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { CodingWorkspaceService } from "../services/workspace-service.ts";
import { tasksAction } from "./tasks.ts";

const ROOM = "55555555-5555-4555-8555-555555555555";
const AGENT = "00000000-0000-4000-8000-000000000001";

function message(text: string): Memory {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    roomId: ROOM,
    // Self-originated: keeps requireTaskAgentAccess satisfied without a
    // roles backend (same pattern as submit-workspace-action.test.ts).
    entityId: AGENT,
    content: { text, metadata: {} },
  } as unknown as Memory;
}

type FakeSession = {
  id: string;
  sessionId: string;
  agentType: string;
  name?: string;
  workdir: string;
  status: string;
  createdAt: Date;
  lastActivityAt: Date;
  metadata: Record<string, unknown>;
};

function fakeSession(id: string, label: string): FakeSession {
  return {
    id,
    sessionId: id,
    agentType: "codex",
    name: label,
    workdir: "/tmp/voice-conversion-test",
    status: "ready",
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    metadata: { label },
  };
}

function makeRuntime(opts: {
  sessions?: FakeSession[];
  useModel?: (...args: unknown[]) => unknown;
  services?: Record<string, unknown>;
}): { runtime: IAgentRuntime; acp: Record<string, unknown> } {
  const sessions = opts.sessions ?? [];
  const acp = {
    listSessions: vi.fn(async () => sessions),
    getSession: vi.fn(async (id: string) => sessions.find((s) => s.id === id)),
    stopSession: vi.fn(async () => undefined),
    updateSessionMetadata: vi.fn(async () => undefined),
    sendToSession: vi.fn(async () => undefined),
  };
  const runtime = {
    agentId: AGENT,
    character: { name: "Voice test" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: vi.fn(() => undefined),
    reportError: vi.fn(),
    ...(opts.useModel ? { useModel: vi.fn(opts.useModel) } : {}),
    getService: (type: string) => {
      if (type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE") {
        return acp;
      }
      return opts.services?.[type];
    },
  } as unknown as IAgentRuntime;
  return { runtime, acp };
}

async function run(
  runtime: IAgentRuntime,
  text: string,
  parameters: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; replies: string[] }> {
  const replies: string[] = [];
  const result = (await tasksAction.handler(
    runtime,
    message(text),
    undefined as unknown as State,
    { parameters },
    async (content) => {
      if (typeof content.text === "string") replies.push(content.text);
      return [];
    },
  )) as Record<string, unknown>;
  return { result, replies };
}

describe("Tier S — planner-facing refusals fire no callback and carry facts", () => {
  it("create cap refusal: no callback, {requestedParts, maxConcurrent} in data", async () => {
    const { runtime } = makeRuntime({});
    const { result, replies } = await run(runtime, "do nine things", {
      action: "create",
      agents: "a1|a2|a3|a4|a5|a6|a7|a8|a9",
    });
    expect(replies).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.error).toBe("TOO_MANY_AGENTS");
    expect(result.data).toMatchObject({
      requestedParts: 9,
      maxConcurrent: 8,
    });
    // A failed result never earns the do-not-paraphrase license.
    expect(result.verifiedUserFacing).toBeUndefined();
  });

  it("duplicate-spawn guard: ONE model-phrased callback (the guard terminates the turn, so it phrases and delivers itself)", async () => {
    const phrased =
      'That one ("build me a website") is already underway — say run it again for a fresh attempt.';
    const useModel = vi.fn(async () => phrased);
    const taskService = {
      listTasks: vi.fn(async () => [
        {
          status: "validating",
          title: "build me a website",
          originalRequest: "build me a personal website",
        },
      ]),
      getTask: vi.fn(async () => undefined),
    };
    const { runtime } = makeRuntime({
      services: { ORCHESTRATOR_TASK_SERVICE: taskService },
      useModel,
    });
    const { result, replies } = await run(runtime, "build me a website", {
      action: "spawn_agent",
      task: "build me a personal website",
      label: "build me a website",
    });
    // Exactly one visible message; canonical text === callback text.
    expect(replies).toEqual([phrased]);
    expect(result.success).toBe(true);
    expect(result.continueChain).toBe(false);
    expect(result.text).toBe(phrased);
    expect(result.userFacingText).toBe(phrased);
    expect(result.data).toMatchObject({
      duplicateSpawnGuard: true,
      duplicateOfLabel: '"build me a website"',
      status: "validating",
    });
    // The frame carried the label receipt and the forbidden claim.
    expect(useModel).toHaveBeenCalledTimes(1);
    const prompt = (useModel.mock.calls[0] as unknown[])[1] as {
      system: string;
    };
    expect(prompt.system).toContain('existingWork: "build me a website"');
    expect(prompt.system).toContain("do not claim: new work started");
    expect(prompt.system).toContain("newAgentStarted: false");
  });

  it("duplicate-spawn guard: model outage degrades to the factual fallback — one message, truthful, no new-work claim", async () => {
    const taskService = {
      listTasks: vi.fn(async () => [
        {
          status: "validating",
          title: "build me a website",
          originalRequest: "build me a personal website",
        },
      ]),
      getTask: vi.fn(async () => undefined),
    };
    const { runtime } = makeRuntime({
      services: { ORCHESTRATOR_TASK_SERVICE: taskService },
    });
    const { result, replies } = await run(runtime, "build me a website", {
      action: "spawn_agent",
      task: "build me a personal website",
      label: "build me a website",
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('"build me a website"');
    expect(replies[0]).toContain("already underway");
    expect(replies[0]).toContain('"run it again"');
    expect(replies[0]).not.toMatch(/started a new|new agent was started/i);
    expect(result.text).toBe(replies[0]);
    expect(result.userFacingText).toBe(replies[0]);
    expect(result.continueChain).toBe(false);
  });

  it("ACP-unavailable guards answer the planner without a callback", async () => {
    const runtime = {
      agentId: AGENT,
      character: { name: "Voice test" },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getSetting: vi.fn(() => undefined),
      reportError: vi.fn(),
      getService: () => undefined,
    } as unknown as IAgentRuntime;
    for (const parameters of [
      { action: "spawn_agent", task: "x" },
      { action: "list_agents" },
      { action: "control", controlAction: "stop" },
      { action: "share" },
    ]) {
      const { result, replies } = await run(runtime, "hey", parameters);
      expect(replies, JSON.stringify(parameters)).toEqual([]);
      expect(result.success).toBe(false);
      expect(result.error).toBe("SERVICE_UNAVAILABLE");
    }
  });
});

describe("Tier H — sole-delivery confirmations are model-phrased", () => {
  it("stop_agent(all): facts reach the model prompt, ONE callback, canonical text === callback text", async () => {
    // Stops now settle against stoppedSessions receipts, so the confirmation
    // stands as-is: one model call phrases it from the frame facts and no
    // unconfirmed-outcome projection runs.
    const useModel = vi.fn(async () => "Both agents are wrapped up now.");
    const { runtime } = makeRuntime({
      sessions: [fakeSession("s-1", "site build"), fakeSession("s-2", "docs")],
      useModel,
    });
    const { result, replies } = await run(runtime, "stop everything", {
      action: "stop_agent",
      all: true,
    });
    // Emission count unchanged: exactly one visible message.
    expect(replies).toEqual(["Both agents are wrapped up now."]);
    expect(result.text).toBe(replies[0]);
    expect(result.userFacingText).toBe(replies[0]);
    expect(result.data).toMatchObject({ stoppedCount: 2 });
    // Exactly one model call: the confirmation phrased from facts. A stop
    // with receipts needs no settle projection call.
    expect(useModel).toHaveBeenCalledTimes(1);
    const confirmPrompt = (useModel.mock.calls[0] as unknown[])[1] as {
      system: string;
    };
    expect(confirmPrompt.system).toContain("stoppedCount: 2");
  });

  it("stop_agent(all): model outage degrades to the factual fallback chain, count unchanged", async () => {
    const { runtime } = makeRuntime({
      sessions: [fakeSession("s-1", "site build")],
    });
    const { result, replies } = await run(runtime, "stop it", {
      action: "stop_agent",
      all: true,
    });
    // No model: the stop's receipts back the factual fallback — one truthful
    // message, canonical equality, no internal vocabulary.
    expect(replies).toEqual(["Stopped 1 task agent."]);
    expect(result.text).toBe(replies[0]);
    expect(result.userFacingText).toBe(replies[0]);
    expect(replies[0]).not.toMatch(/receipt|commit|session|acp/i);
  });

  it("cancel(single): raw session id never reaches chat; facts + label reach the model", async () => {
    const useModel = vi.fn(async () => "Wrapped that one up for you.");
    const { runtime } = makeRuntime({
      sessions: [fakeSession("sess-abcdef12", "widget build")],
      useModel,
    });
    const { result, replies } = await run(runtime, "cancel it", {
      action: "cancel",
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toContain("sess-abcdef12");
    expect(result.data).toMatchObject({ sessionId: "sess-abcdef12" });
    // The confirm frame carried the LABEL as an exact-inclusion receipt.
    const confirmPrompt = (useModel.mock.calls[0] as unknown[])[1] as {
      system: string;
    };
    expect(confirmPrompt.system).toContain('include exactly: "widget build"');
    expect(confirmPrompt.system).toContain("canceledCount: 1");
  });

  it("banned mechanism vocabulary in model output falls back to the factual string", async () => {
    const useModel = vi.fn(
      async () => "The session was stopped by the orchestrator.",
    );
    const { runtime } = makeRuntime({
      sessions: [fakeSession("s-1", "site build")],
      useModel,
    });
    const { replies } = await run(runtime, "stop it", {
      action: "stop_agent",
      all: true,
    });
    // The confirm phrasing rejected the banned-vocab output, so the factual
    // receipt-backed fallback is what ships.
    expect(replies).toEqual(["Stopped 1 task agent."]);
  });

  it("issue create: model prose + byte-identical URL appendix, ONE callback, receipts bound", async () => {
    const useModel = vi.fn(async () => "Filed #7 for you.");
    const issue = {
      number: 7,
      url: "https://github.com/acme/widgets/issues/7",
      state: "open" as const,
      title: "Widget",
      body: "",
      labels: [],
      assignees: [],
      createdAt: new Date(0),
    };
    const { runtime } = makeRuntime({ useModel });
    const workspace = new CodingWorkspaceService(runtime, {
      baseDir: "/tmp/voice-conversion-test",
    });
    workspace.createIssue = vi.fn(async () => issue);
    const services: Record<string, unknown> = {
      [CodingWorkspaceService.serviceType]: workspace,
    };
    (runtime as { getService: unknown }).getService = (type: string) =>
      services[type];
    const { result, replies } = await run(runtime, "file an issue", {
      action: "manage_issues",
      issueAction: "create",
      repo: "acme/widgets",
      title: "Widget",
    });
    expect(replies).toEqual([
      "Filed #7 for you.\n\nhttps://github.com/acme/widgets/issues/7",
    ]);
    expect(result.userFacingText).toBe(replies[0]);
    expect(result.text).toBe(replies[0]);
    expect(result.verifiedUserFacing).toBe(true);
    expect(result.effectReceipts).toEqual([
      expect.objectContaining({
        outcome: "applied",
        resource: {
          kind: "github.issue",
          id: "https://github.com/acme/widgets/issues/7",
        },
      }),
    ]);
    expect(result.userFacingEffectReceiptIds).toEqual([
      (result.effectReceipts as Array<{ receiptId: string }>)[0].receiptId,
    ]);
  });

  it("issue create: a model answer that drops the issue number falls back — appendix intact", async () => {
    const useModel = vi.fn(async () => "Filed it for you.");
    const issue = {
      number: 7,
      url: "https://github.com/acme/widgets/issues/7",
      state: "open" as const,
      title: "Widget",
      body: "",
      labels: [],
      assignees: [],
      createdAt: new Date(0),
    };
    const { runtime } = makeRuntime({ useModel });
    const workspace = new CodingWorkspaceService(runtime, {
      baseDir: "/tmp/voice-conversion-test",
    });
    workspace.createIssue = vi.fn(async () => issue);
    const services: Record<string, unknown> = {
      [CodingWorkspaceService.serviceType]: workspace,
    };
    (runtime as { getService: unknown }).getService = (type: string) =>
      services[type];
    const { replies } = await run(runtime, "file an issue", {
      action: "manage_issues",
      issueAction: "create",
      repo: "acme/widgets",
      title: "Widget",
    });
    expect(replies).toEqual([
      "Created issue #7: Widget\n\nhttps://github.com/acme/widgets/issues/7",
    ]);
    // Never a second model call after the validation miss.
    expect(useModel).toHaveBeenCalledTimes(1);
  });
});
