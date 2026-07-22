/**
 * Verifies subAgentCompletionResponseEvaluator.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
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
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: "https://example.test/apps/demo/",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
  });

  it("strips the anti-respawn directive header so it never leaks to the user", async () => {
    // composeNarration enriches the task_complete header with a planner-only
    // "do NOT start another sub-agent" directive (inside the brackets). The
    // header stripper must still drop the whole line, leaving only the
    // deliverable — the directive must never reach the user.
    const context = makeContext({
      text: "[sub-agent: Use the webfetch tool on this exact URL: https://api.example.test/price (claude) — task_complete — this delegated task is DONE; the result is below, relay it to the user as the answer, do NOT start another sub-agent for it]\n63411",
    });

    const result = await subAgentCompletionResponseEvaluator.evaluate(context);
    expect(result?.reply).toBe("63411");
    expect(result?.reply).not.toContain("do NOT start another sub-agent");
    expect(result?.reply).not.toContain("webfetch");
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
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: "https://example.test/apps/demo/",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
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
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: "The static app is live at https://example.test/apps/demo/",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
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
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply:
          "Built the random tweet generator.\nPublic URL https://example.test/apps/random-tweet/",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
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
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply:
          "The app is live at https://example.test/apps/nebula/. Let me know if you'd like tweaks.",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
  });

  it("keeps clean completion prose after stripped tool output when it cites a verified URL", async () => {
    const context = makeContext({
      text: "[sub-agent: nebula app (opencode) — task_complete]\n[tool output: find files]\n/home/user/project/.git/config\n/home/user/project/data/apps/nebula/index.html\n[/tool output]\nBuilt Nebula Garden with product cards and a waitlist CTA.\nLive URL: https://example.test/apps/nebula/.",
      metadata: {
        subAgentVerifiedUrls: ["https://example.test/apps/nebula/"],
      },
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "https://example.test/apps/nebula/",
          requiresTool: true,
          candidateActions: ["SHELL"],
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply:
          "Built Nebula Garden with product cards and a waitlist CTA.\nLive URL: https://example.test/apps/nebula/.",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
  });

  it("prefers the public verified URL when completion only contains URL aliases", async () => {
    const context = makeContext({
      text: "[sub-agent: tweet app (opencode) — task_complete]\nhttp://127.0.0.1:6900/apps/random-tweet/\nhttps://example.test/apps/random-tweet/",
      metadata: {
        subAgentVerifiedUrls: [
          "http://127.0.0.1:6900/apps/random-tweet/",
          "https://example.test/apps/random-tweet/",
        ],
      },
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: "https://example.test/apps/random-tweet/",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
  });

  it("keeps a clean synthesized reply when bare completion URLs are verified", async () => {
    const context = makeContext({
      text: "[sub-agent: permit garden (opencode) — task_complete]\nhttp://127.0.0.1:6900/apps/permit-garden/\nhttps://example.test/apps/permit-garden/",
      metadata: {
        subAgentVerifiedUrls: [
          "http://127.0.0.1:6900/apps/permit-garden/",
          "https://example.test/apps/permit-garden/",
        ],
      },
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply:
            "✅ Built Permit Garden as a fictional bureaucratic zine and sticker landing page. It has product cards, pricing, and a waitlist CTA: https://example.test/apps/permit-garden/",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply:
          "Built Permit Garden as a fictional bureaucratic zine and sticker landing page. It has product cards, pricing, and a waitlist CTA: https://example.test/apps/permit-garden/",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
  });

  it("removes loopback route aliases from verified app completion replies", async () => {
    const context = makeContext({
      text: "[sub-agent: civic vitrine (opencode) — task_complete]\nBuilt Civic Vitrine.\n- URL: http://127.0.0.1:6900/apps/civic-vitrine/\n- Public URL: https://example.test/apps/civic-vitrine/\n- Waitlist form: local submit handler.",
      metadata: {
        subAgentVerifiedUrls: [
          "http://127.0.0.1:6900/apps/civic-vitrine/",
          "https://example.test/apps/civic-vitrine/",
        ],
      },
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply:
            "✅ Civic Vitrine site built. You can view it locally at http://127.0.0.1:6900/apps/civic-vitrine/ and publicly at https://example.test/apps/civic-vitrine/.",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply:
          "Built Civic Vitrine.\n- Public URL: https://example.test/apps/civic-vitrine/\n- Waitlist form: local submit handler.",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
  });

  it("appends the public verified URL to a clean synthesized reply that omits it", async () => {
    const context = makeContext({
      text: "[sub-agent: queue cathedral (opencode) — task_complete]\nhttp://127.0.0.1:6900/apps/queue-cathedral/\nhttps://example.test/apps/queue-cathedral/",
      metadata: {
        subAgentVerifiedUrls: [
          "http://127.0.0.1:6900/apps/queue-cathedral/",
          "https://example.test/apps/queue-cathedral/",
        ],
      },
      messageHandler: {
        plan: {
          contexts: ["simple"],
          reply:
            "The Queue Cathedral site is live with product cards, prices, and a waitlist CTA.",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply:
          "The Queue Cathedral site is live with product cards, prices, and a waitlist CTA.\nhttps://example.test/apps/queue-cathedral/",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
  });

  it("suppresses empty task_complete placeholders", async () => {
    const context = makeContext({
      text: "[sub-agent: tweet app (opencode) — task_complete]\nsub-agent reports task complete (no captured output).",
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "sub-agent reports task complete (no captured output).",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        processMessage: "IGNORE",
        requiresTool: false,
        clearReply: true,
        clearCandidateActions: true,
        clearParentActionHints: true,
        debug: [
          "verified sub-agent completion had no captured output; suppressing empty reply",
        ],
      },
    );
  });

  it("uses non-URL sub-agent completion text instead of a generic model reply", async () => {
    const context = makeContext({
      text: "[sub-agent: disk check (opencode) — task_complete]\nRoot / is 84% used. /home is 57% used.",
      messageHandler: {
        plan: {
          contexts: ["simple"],
          candidateActions: ["ATTACHMENT"],
          reply:
            "Could you share the command output so I can see the disk usage?",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: "Root / is 84% used. /home is 57% used.",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
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
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: true,
        // `automation` (not `general`) is the context the TASKS contextGate
        // accepts. Routing through TASKS_SEND_TO_AGENT with the wrong
        // context would fail `executePlannedToolCall` with "Action TASKS_*
        // is not allowed in the current context".
        setContexts: ["automation"],
        clearReply: true,
        addCandidateActions: ["TASKS_SEND_TO_AGENT"],
        addParentActionHints: ["TASKS"],
        debug: [
          "verified sub-agent completion only contains captured tool output; routing back through TASKS for follow-up",
        ],
      },
    );
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
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: "Root / is 84% used with 7.0G available.",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
  });

  it("surfaces clean zero-result completions instead of re-querying the sub-agent", async () => {
    const context = makeContext({
      text: "[sub-agent: source count (opencode) — task_complete]\n[tool output: Find matching source files]\nNo files found\n[/tool output]\nNo files found for the requested source-file search.",
      messageHandler: {
        plan: {
          contexts: ["simple"],
          reply: "I found 3 source files.",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: "No files found for the requested source-file search.",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
  });

  it("routes command failures back through TASKS for grounded follow-up", async () => {
    const context = makeContext({
      text: "[sub-agent: source count (opencode) — task_complete]\n[tool output: Find matching source files]\nrg: command not found\n[/tool output]\nThe search command failed with command not found.",
      messageHandler: {
        plan: {
          contexts: ["simple"],
          reply: "I found 3 source files.",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: true,
        setContexts: ["automation"],
        clearReply: true,
        addCandidateActions: ["TASKS_SEND_TO_AGENT"],
        addParentActionHints: ["TASKS"],
        debug: [
          "sub-agent completion contains failure markers without clear positive evidence; routing back through TASKS for grounded follow-up",
        ],
      },
    );
  });

  it("does not use fabricated quantitative replies when hidden no-result output has unrelated prose", async () => {
    const context = makeContext({
      text: "[sub-agent: source count (opencode) — task_complete]\n[tool output: Find matching source files]\nNo files found\n[/tool output]\n[tool output: List project root]\nREADME.md\npackage.json\ntsconfig.json\n[/tool output]\nThe project root contains unrelated files.",
      messageHandler: {
        plan: {
          contexts: ["simple"],
          reply: "I found 3 source files.",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: true,
        setContexts: ["automation"],
        clearReply: true,
        addCandidateActions: ["TASKS_SEND_TO_AGENT"],
        addParentActionHints: ["TASKS"],
        debug: [
          "sub-agent completion contains failure markers without clear positive evidence; routing back through TASKS for grounded follow-up",
        ],
      },
    );
  });

  it("allows positive quantitative completions even when phrased as a count", async () => {
    const context = makeContext({
      text: "[sub-agent: source count (opencode) — task_complete]\nFound 3 matching source files: src/a.ts, src/b.ts, and src/c.ts.",
      messageHandler: {
        plan: {
          contexts: ["simple"],
          reply: "Could you share the file count?",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply:
          "Found 3 matching source files: src/a.ts, src/b.ts, and src/c.ts.",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
  });

  it("allows positive quantitative completions with larger spelled-out counts", async () => {
    const context = makeContext({
      text: "[sub-agent: source count (opencode) — task_complete]\nFound thirteen matching source files; no files were missing from the requested search.",
      messageHandler: {
        plan: {
          contexts: ["simple"],
          reply: "Could you share the file count?",
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply:
          "Found thirteen matching source files; no files were missing from the requested search.",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
  });

  it("prefers a clean final answer over a raw transcript reply with incidental URLs", async () => {
    const context = makeContext({
      text: '[sub-agent: package check (opencode) — task_complete]\n[tool output: packages/core/package.json]\n{"name":"@elizaos/core","homepage":"https://github.com/elizaOS/eliza","repository":{"url":"git+https://github.com/elizaOS/eliza.git"}}\n[/tool output]@elizaos/core',
      messageHandler: {
        plan: {
          contexts: ["simple"],
          reply:
            '[tool output: packages/core/package.json]\n{"name":"@elizaos/core","homepage":"https://github.com/elizaOS/eliza","repository":{"url":"git+https://github.com/elizaOS/eliza.git"}}\n[/tool output]@elizaos/core',
          requiresTool: false,
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: "@elizaos/core",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
  });

  it("does not run a follow-up tool when tool output is followed by a clean final answer", async () => {
    const context = makeContext({
      text: '[sub-agent: package check (opencode) — task_complete]\n[tool output: packages/core/package.json]\n{"name":"@elizaos/core","homepage":"https://github.com/elizaOS/eliza"}\n[/tool output]The package name is `@elizaos/core`.',
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "",
          requiresTool: true,
          candidateActions: ["SHELL"],
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: "The package name is `@elizaos/core`.",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
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
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
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
      },
    );
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

  it("relays a short bare value instead of re-spawning the same just-finished lookup", async () => {
    // Live regression on the claude backend: a "fetch the price, reply with ONLY
    // the value" sub-agent returned "$1,708.31" as bare text (no [tool output:…]
    // envelope, so it was never captured as a deliverable). The planner re-read
    // the imperative task label and re-spawned the SAME lookup — 6 sessions, no
    // answer. A short clean body whose only follow-up is a FRESH spawn must be
    // relayed, not looped.
    const context = makeContext({
      text: "[sub-agent: Use the webfetch tool on this exact URL: https://api.example.test/price (claude) — task_complete]\n$1,708.31",
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "I'll fetch that price.",
          requiresTool: true,
          candidateActions: ["TASKS_SPAWN_AGENT"],
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    const result = await subAgentCompletionResponseEvaluator.evaluate(context);
    expect(result?.requiresTool).toBe(false);
    expect(result?.clearCandidateActions).toBe(true);
    expect(result?.reply).toBe("$1,708.31");
  });

  it("relays a short answer even when the re-spawn carries NO candidateActions hint", async () => {
    // Live cerebras-weather regression: the planner re-issued TASKS:create
    // directly without populating candidateActions, so a fresh-spawn-only check
    // missed it and the lookup re-spawned (the "working on it" x2 UX). Relay
    // whenever the plan is not continuing the existing session.
    const context = makeContext({
      text: "[sub-agent: Fetch the current weather in Tokyo (codex) — task_complete]\nTokyo: 🌦️ +74°F",
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "Fetching Tokyo weather...",
          requiresTool: true,
          // no candidateActions / parentActionHints at all
        },
      },
    });

    expect(subAgentCompletionResponseEvaluator.shouldRun(context)).toBe(true);
    const result = await subAgentCompletionResponseEvaluator.evaluate(context);
    expect(result?.requiresTool).toBe(false);
    expect(result?.clearCandidateActions).toBe(true);
    expect(result?.reply).toBe("Tokyo: 🌦️ +74°F");
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
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: "Your app is live at https://example.test/apps/demo/.",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
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
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: "https://example.test/apps/demo/",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
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
    expect(await subAgentCompletionResponseEvaluator.evaluate(context)).toEqual(
      {
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: "Created the random tweet app files and verified the build.",
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      },
    );
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

  it("does not mis-flag URL paths in prose as raw tool transcripts", async () => {
    // Regression: the old `/^\/[^\s]+/m` heuristic fired on any line starting
    // with `/`, including URL paths the sub-agent mentions in prose
    // (`/admin`, `/posts/123`). After tightening the regex to known top-level
    // dirs (`/Users|home|root|...`), these completions should flow through
    // as direct replies instead of being routed back through TASKS as a
    // suspected transcript leak.
    const context = makeContext({
      text: "[sub-agent: blog (opencode) — task_complete]\nDeployed the blog. The admin panel is mounted at /admin and posts live under /posts/123.\nhttps://example.test/blog/",
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "https://example.test/blog/",
          requiresTool: false,
        },
      },
    });

    const patch = await subAgentCompletionResponseEvaluator.evaluate(context);
    expect(patch.requiresTool).toBe(false);
    // The body (which contains `/admin` and `/posts/123`) is NOT flagged as
    // raw transcript — the reply path picks up the prose+URL body.
    expect(patch.reply).toContain("/admin");
    expect(patch.reply).toContain("/posts/123");
    expect(patch.reply).toContain("https://example.test/blog/");
  });

  it("still flags absolute filesystem paths as raw tool transcripts", async () => {
    // Positive: `/Users/...` and `/var/...` remain tool-transcript signals,
    // so the evaluator routes such completions back through TASKS rather
    // than leaking the path to the user.
    const context = makeContext({
      text: "[sub-agent: demo (opencode) — task_complete]\nFound files:\n/Users/stan/projects/demo/index.html\n/var/log/app.log",
      metadata: {
        subAgentVerifiedUrls: ["https://example.test/apps/demo/"],
      },
      messageHandler: {
        plan: {
          contexts: ["general"],
          reply: "https://example.test/apps/demo/",
          requiresTool: true,
          candidateActions: ["SHELL"],
        },
      },
    });

    const patch = await subAgentCompletionResponseEvaluator.evaluate(context);
    // Verified URL is used (the raw paths are detected and the verified URL
    // wins over the unsafe completion body).
    expect(patch.reply).toBe("https://example.test/apps/demo/");
    expect(patch.reply).not.toContain("/Users/");
    expect(patch.reply).not.toContain("/var/");
  });
});
