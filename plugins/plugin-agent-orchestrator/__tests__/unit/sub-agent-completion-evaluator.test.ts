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
      clearCandidateActions: true,
      clearParentActionHints: true,
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
      clearCandidateActions: true,
      clearParentActionHints: true,
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
      clearCandidateActions: true,
      clearParentActionHints: true,
      reply: "The static app is live at https://example.test/apps/demo/",
      debug: [
        "verified sub-agent completion has no concrete follow-up action; using direct reply",
      ],
    });
  });

  it("prefers grounded completion prose over a model-invented URL reply", async () => {
    const context = makeContext({
      text: "[sub-agent: tweet app (opencode) — task_complete]\n[tool output: Check external]\nHTTP/2 200\n[/tool output]\nBuilt the random tweet generator.\nPublic URL https://example.test/apps/random-tweet/",
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply:
            "Glad to hear the random tweet generator is live at https://example.test/apps/random-tweet/.",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(subAgentCompletionResponseEvaluator.evaluate(context)).toEqual({
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      clearCandidateActions: true,
      clearParentActionHints: true,
      reply:
        "Built the random tweet generator.\nPublic URL https://example.test/apps/random-tweet/",
      debug: [
        "verified sub-agent completion has no concrete follow-up action; using direct reply",
      ],
    });
  });

  it("uses verified URLs instead of leaking raw tool transcripts", async () => {
    const context = makeContext({
      text: "[sub-agent: nebula app (opencode) — task_complete]\n[tool output: find files]\n/home/user/project/.git/config\n/home/user/project/data/apps/nebula/index.html\n[/tool output]\nI'll follow redirect.\nThe app is live at https://example.test/apps/nebula/.",
      metadata: {
        subAgentVerifiedUrls: ["https://example.test/apps/nebula/"],
      },
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply:
            "The app is live at https://example.test/apps/nebula/. Let me know if you'd like tweaks.",
          requiresTool: true,
          candidateActions: ["SHELL"],
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(subAgentCompletionResponseEvaluator.evaluate(context)).toEqual({
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      clearCandidateActions: true,
      clearParentActionHints: true,
      reply: "https://example.test/apps/nebula/",
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
      clearCandidateActions: true,
      clearParentActionHints: true,
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
      clearCandidateActions: true,
      clearParentActionHints: true,
      reply: "Root / is 84% used with 7.0G available.",
      debug: [
        "verified sub-agent completion has no concrete follow-up action; using direct reply",
      ],
    });
  });

  it("promotes ignored verified task_complete messages into direct replies", async () => {
    const context = makeContext({
      text: "[sub-agent: tweet app (opencode) — task_complete]\n[tool output: Check external]\nHTTP/2 200\n[/tool output]\nBuilt data/apps/random-tweet/index.html.\nPublic URL https://example.test/apps/random-tweet/",
      messageHandler: {
        processMessage: "IGNORE",
        plan: {
          contexts: ["general"],
          reply: "",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(subAgentCompletionResponseEvaluator.evaluate(context)).toEqual({
      processMessage: "RESPOND",
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      clearCandidateActions: true,
      clearParentActionHints: true,
      reply:
        "Built data/apps/random-tweet/index.html.\nPublic URL https://example.test/apps/random-tweet/",
      debug: [
        "verified sub-agent completion has no concrete follow-up action; using direct reply",
      ],
    });
  });

  it("keeps the normal action layer when Stage 1 requested a follow-up action", async () => {
    const context = makeContext({
      text: "[sub-agent: demo (opencode) — task_complete]\nThe app still needs an API key before it can finish.",
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

  it("overrides stale concrete action hints when the verified completion already has a URL reply", async () => {
    const context = makeContext({
      text: "[sub-agent: demo (opencode) — task_complete]\n[tool output: tool output]\nNo files found\n[/tool output]\nYour app is live at https://example.test/apps/demo/.",
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "Your app is live at https://example.test/apps/demo/.",
          requiresTool: true,
          candidateActions: ["SHELL"],
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(subAgentCompletionResponseEvaluator.evaluate(context)).toEqual({
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      clearCandidateActions: true,
      clearParentActionHints: true,
      reply: "Your app is live at https://example.test/apps/demo/.",
      debug: [
        "verified sub-agent completion has no concrete follow-up action; using direct reply",
      ],
    });
  });

  it("uses router-verified URLs when the sub-agent completion text omits them", async () => {
    const context = makeContext({
      text: "[sub-agent: demo (opencode) — task_complete]\nCreated app directory and files.",
      metadata: {
        subAgentVerifiedUrls: [
          "http://127.0.0.1:6900/apps/demo/",
          "https://example.test/apps/demo/",
        ],
      },
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "On it — spawning opencode sub-agent now.",
          requiresTool: true,
          candidateActions: ["TASKS_SPAWN_AGENT"],
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(subAgentCompletionResponseEvaluator.evaluate(context)).toEqual({
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      clearCandidateActions: true,
      clearParentActionHints: true,
      reply: "https://example.test/apps/demo/",
      debug: [
        "verified sub-agent completion has no concrete follow-up action; using direct reply",
      ],
    });
  });

  it("does not respawn after a successful completion when Stage 1 inferred a stale spawn hint", async () => {
    const context = makeContext({
      text: "[sub-agent: tweet app (opencode) — task_complete]\nCreated the random tweet app files and verified the build.",
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "On it — spawning opencode sub-agent to handle your request.",
          requiresTool: true,
          candidateActions: ["TASKS_SPAWN_AGENT"],
          parentActionHints: ["TASKS"],
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(subAgentCompletionResponseEvaluator.evaluate(context)).toEqual({
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      clearCandidateActions: true,
      clearParentActionHints: true,
      reply: "Created the random tweet app files and verified the build.",
      debug: [
        "verified sub-agent completion has no concrete follow-up action; using direct reply",
      ],
    });
  });

  it("surfaces incomplete build reports without spawning another agent", async () => {
    const context = makeContext({
      text: "[sub-agent: demo (opencode) — task_complete]\nDone: https://example.test/apps/demo/\n\n[verification: the following URL(s) the sub-agent referenced are NOT reachable — do NOT tell the user the app is live]\n  - https://example.test/apps/demo/ → HTTP 404",
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "On it — spawning opencode sub-agent to handle your request.",
          requiresTool: true,
          candidateActions: ["TASKS_SPAWN_AGENT"],
          parentActionHints: ["TASKS"],
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(subAgentCompletionResponseEvaluator.evaluate(context)).toEqual({
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      clearCandidateActions: true,
      clearParentActionHints: true,
      reply:
        "The sub-agent reported completion, but verification failed, so I am not treating the app as live yet.\nUnreachable URL(s):\n- https://example.test/apps/demo/ → HTTP 404",
      debug: [
        "sub-agent completion failed verification; surfacing failure without re-dispatch",
      ],
    });
  });

  it("does not handle non-completion sub-agent events", async () => {
    const context = makeContext({
      metadata: { subAgentEvent: "blocked" },
      text: "[sub-agent: demo (opencode) — blocked]\nNeed credentials.",
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(false);
  });
});
