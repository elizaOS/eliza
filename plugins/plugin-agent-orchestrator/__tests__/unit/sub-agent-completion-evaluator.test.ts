import type {
  Memory,
  MessageHandlerResult,
  ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import { SIMPLE_CONTEXT_ID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { subAgentCompletionResponseEvaluator } from "../../src/evaluators/sub-agent-completion.js";

function makeContext(overrides: {
  text?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  messageHandler?: Partial<MessageHandlerResult>;
}): ResponseHandlerEvaluatorContext {
  const messageHandler: MessageHandlerResult = {
    processMessage: "RESPOND",
    thought: "",
    plan: {
      contexts: ["general"],
      reply: "Thanks, the app is live and all URLs return HTTP 200.",
      requiresTool: true,
      ...overrides.messageHandler?.plan,
    },
    ...overrides.messageHandler,
  };
  const message = {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: {
      text:
        overrides.text ??
        "[sub-agent: demo (opencode) — task_complete]\nhttps://example.test/apps/demo/",
      source: overrides.source ?? "sub_agent",
      metadata: {
        subAgent: true,
        subAgentEvent: "task_complete",
        subAgentStatus: "ready",
        ...overrides.metadata,
      },
    },
  } as Memory;
  return {
    runtime: {} as never,
    message,
    state: {} as never,
    messageHandler,
    availableContexts: [{ id: SIMPLE_CONTEXT_ID, description: "simple" }],
  };
}

describe("subAgentCompletionResponseEvaluator", () => {
  it("turns verified task_complete posts into direct replies", async () => {
    const context = makeContext({});

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(subAgentCompletionResponseEvaluator.evaluate(context)).toEqual({
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      reply: "https://example.test/apps/demo/",
      debug: [
        "verified sub-agent completion has no concrete follow-up action; using direct reply",
      ],
    });
  });

  it("posts verified URL replies even when Stage 1 inferred generic TASKS", async () => {
    const context = makeContext({
      text: "[sub-agent: demo (opencode) — task_complete]\nSearch for data/apps directory.\n[tool output: data/apps]\n/workspace/apps/demo/index.html",
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "https://example.test/apps/demo/",
          requiresTool: true,
          candidateActions: ["TASKS"],
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(subAgentCompletionResponseEvaluator.evaluate(context)).toEqual({
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      reply: "https://example.test/apps/demo/",
      debug: [
        "verified sub-agent completion has no concrete follow-up action; using direct reply",
      ],
    });
  });

  it("does not re-query the sub-agent when a captured-output completion already has a URL reply", async () => {
    const context = makeContext({
      text: "[sub-agent: demo (opencode) — task_complete]\n[tool output: data/apps]\n/workspace/apps/demo/index.html",
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "The static app is live at https://example.test/apps/demo/",
          requiresTool: true,
          candidateActions: ["TASKS"],
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(subAgentCompletionResponseEvaluator.evaluate(context)).toEqual({
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      reply: "The static app is live at https://example.test/apps/demo/",
      debug: [
        "verified sub-agent completion has no concrete follow-up action; using direct reply",
      ],
    });
  });

  it("uses non-URL sub-agent completion text instead of a generic model reply", async () => {
    const context = makeContext({
      text: "[sub-agent: disk check (opencode) — task_complete]\nRoot / is 84% used. /home is 57% used.",
      messageHandler: {
        plan: {
          contexts: ["simple"],
          reply:
            "Could you share the command output so I can see the disk usage?",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(subAgentCompletionResponseEvaluator.evaluate(context)).toEqual({
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      reply: "Root / is 84% used. /home is 57% used.",
      debug: [
        "verified sub-agent completion has no concrete follow-up action; using direct reply",
      ],
    });
  });

  it("routes captured tool-output-only completions back through TASKS", async () => {
    const context = makeContext({
      text: "[sub-agent: disk check (opencode) — task_complete]\n[tool output: Get disk usage percentages]\nFilesystem      Size  Used Avail Use% Mounted on\n/dev/root        45G   38G  7.0G  84% /\n[/tool output]",
      messageHandler: {
        plan: {
          contexts: ["simple"],
          reply:
            "Could you share the command output so I can see the disk usage?",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(subAgentCompletionResponseEvaluator.evaluate(context)).toEqual({
      requiresTool: true,
      setContexts: ["general"],
      clearReply: true,
      addCandidateActions: ["TASKS_SEND_TO_AGENT"],
      addParentActionHints: ["TASKS"],
      debug: [
        "verified sub-agent completion only contains captured tool output; routing back through TASKS for follow-up",
      ],
    });
  });

  it("uses final prose when captured tool output is followed by a real answer", async () => {
    const context = makeContext({
      text: "[sub-agent: disk check (opencode) — task_complete]\n[tool output: Get disk usage percentages]\nFilesystem      Size  Used Avail Use% Mounted on\n/dev/root        45G   38G  7.0G  84% /\n[/tool output]\nRoot / is 84% used with 7.0G available.",
      messageHandler: {
        plan: {
          contexts: ["simple"],
          reply:
            "Could you share the command output so I can see the disk usage?",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(subAgentCompletionResponseEvaluator.evaluate(context)).toEqual({
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      reply: "Root / is 84% used with 7.0G available.",
      debug: [
        "verified sub-agent completion has no concrete follow-up action; using direct reply",
      ],
    });
  });

  it("keeps the normal action layer when Stage 1 requested a follow-up action", async () => {
    const context = makeContext({
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "I'll ask the sub-agent for the missing detail.",
          requiresTool: true,
          candidateActions: ["TASKS_SEND_TO_AGENT"],
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(false);
  });

  it("does not suppress incomplete build reports", async () => {
    const context = makeContext({
      text: "[sub-agent: demo (opencode) — task_complete]\nDone: https://example.test/apps/demo/\n\n[verification: the following URL(s) the sub-agent referenced are NOT reachable — do NOT tell the user the app is live]",
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(false);
  });

  it("does not handle non-completion sub-agent events", async () => {
    const context = makeContext({
      metadata: { subAgentEvent: "blocked" },
      text: "[sub-agent: demo (opencode) — blocked]\nNeed credentials.",
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(false);
  });
});
