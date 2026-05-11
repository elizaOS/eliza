import { describe, expect, it } from "vitest";

import {
  compactors,
  findSafeCompactionBoundary,
  hierarchicalSummaryCompactor,
  hybridLedgerCompactor,
  naiveSummaryCompactor,
  structuredStateCompactor,
} from "./conversation-compactor.ts";
import {
  approxCountTokens,
  type CompactorMessage,
  type CompactorModelCall,
  type CompactorOptions,
  type CompactorTranscript,
} from "./conversation-compactor.types.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeNaive(): CompactorModelCall {
  return async ({ messages }) => {
    const userBody = messages.map((m) => m.content).join(" ");
    return `summary(len=${userBody.length})`;
  };
}

function fakeStructured(state: {
  facts?: string[];
  decisions?: string[];
  pending_actions?: string[];
  forbidden_behaviors?: string[];
  entities?: Record<string, string>;
}): CompactorModelCall {
  const payload = JSON.stringify({
    facts: state.facts ?? [],
    decisions: state.decisions ?? [],
    pending_actions: state.pending_actions ?? [],
    forbidden_behaviors: state.forbidden_behaviors ?? [],
    entities: state.entities ?? {},
  });
  return async () => payload;
}

function fakeHybrid(payload: {
  state?: {
    facts?: string[];
    decisions?: string[];
    pending_actions?: string[];
    forbidden_behaviors?: string[];
    entities?: Record<string, string>;
  };
  ledger?: Array<{ index: number; note: string }>;
}): CompactorModelCall {
  const out = JSON.stringify({
    state: {
      facts: payload.state?.facts ?? [],
      decisions: payload.state?.decisions ?? [],
      pending_actions: payload.state?.pending_actions ?? [],
      forbidden_behaviors: payload.state?.forbidden_behaviors ?? [],
      entities: payload.state?.entities ?? {},
    },
    ledger: payload.ledger ?? [],
  });
  return async () => out;
}

// A fake that round-trips: parses incoming "Existing ledger" if present,
// merges with new state extracted by simple keyword matching, returns a JSON
// payload faithful to the contract. Used for multi-cycle drift tests.
function makeRoundTripHybrid(): CompactorModelCall {
  return async ({ messages }) => {
    const body = messages.map((m) => m.content).join("\n");

    // Carry-forward: extract any prior ledger lines like "- @N: note"
    const priorLedger: Array<{ index: number; note: string }> = [];
    const priorFacts: string[] = [];
    const priorEntities: Record<string, string> = {};
    const ledgerSection = body.match(
      /Existing ledger[\s\S]*?(?=\n\nNew conversation|Z)/,
    );
    if (ledgerSection) {
      const lines = ledgerSection[0].split("\n");
      for (const line of lines) {
        const m = /^- @(\d+):\s*(.+)$/.exec(line.trim());
        if (m) {
          priorLedger.push({ index: Number(m[1]), note: m[2] });
        }
        const fm = /^- ([^:]+: .+)$/.exec(line.trim());
        if (fm && line.includes(":") && !line.startsWith("- @")) {
          priorFacts.push(fm[1]);
        }
        const em = /^- ([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/.exec(line.trim());
        if (em && !line.startsWith("- @")) {
          priorEntities[em[1]] = em[2];
        }
      }
    }

    // Pull "FACT: ..." and "ENTITY name=desc" tokens from the new content as
    // a stand-in for real comprehension.
    const newFacts: string[] = [];
    for (const m of body.matchAll(/FACT:\s*([^\n]+)/g)) {
      newFacts.push(m[1].trim());
    }
    const newEntities: Record<string, string> = {};
    for (const m of body.matchAll(
      /ENTITY\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n]+)/g,
    )) {
      newEntities[m[1]] = m[2].trim();
    }

    const allFacts = Array.from(new Set([...priorFacts, ...newFacts]));
    const allEntities = { ...priorEntities, ...newEntities };
    const allLedger = [
      ...priorLedger,
      ...newFacts.map((f, i) => ({
        index: priorLedger.length + i,
        note: f,
      })),
    ];

    return JSON.stringify({
      state: {
        facts: allFacts,
        decisions: [],
        pending_actions: [],
        forbidden_behaviors: [],
        entities: allEntities,
      },
      ledger: allLedger,
    });
  };
}

function buildOptions(
  partial: Partial<CompactorOptions> = {},
): CompactorOptions {
  return {
    targetTokens: 1024,
    countTokens: approxCountTokens,
    summarizationModel: "fake-model",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// findSafeCompactionBoundary
// ---------------------------------------------------------------------------

describe("findSafeCompactionBoundary", () => {
  it("returns total when there is nothing to compact (tail covers all)", () => {
    const msgs: CompactorMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(findSafeCompactionBoundary(msgs, 10)).toBe(0);
  });

  it("with no tool calls, boundary is total - tail", () => {
    const msgs: CompactorMessage[] = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `m${i}`,
      })),
    ];
    expect(findSafeCompactionBoundary(msgs, 6)).toBe(15); // 21 - 6
  });

  it("shifts boundary outward when a tool_call straddles it", () => {
    // Layout: [system, u, a, u, a(toolCall id=1), tool(id=1), a, u]
    // length=8, tail=4 → boundary=4 splits a(call) (idx4) from tool (idx5)
    const msgs: CompactorMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u0" },
      { role: "assistant", content: "a0" },
      { role: "user", content: "u1" },
      {
        role: "assistant",
        content: "calling",
        toolCalls: [{ id: "1", name: "search", arguments: {} }],
      },
      { role: "tool", content: "result", toolCallId: "1", toolName: "search" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u2" },
    ];
    const boundary = findSafeCompactionBoundary(msgs, 4);
    // Producer is at index 4 — boundary must be <= 4 so the producer is
    // either preserved with the consumer, or summarized with the consumer.
    // Our impl pulls boundary down to producer index 4 to keep the pair
    // together on the preserved side.
    expect(boundary).toBeLessThanOrEqual(4);
    // Both sides of the pair must be on the same side.
    const producerSide = 4 < boundary ? "compact" : "tail";
    const consumerSide = 5 < boundary ? "compact" : "tail";
    expect(producerSide).toBe(consumerSide);
  });

  it("handles nested tool calls (multiple calls in one assistant turn)", () => {
    const msgs: CompactorMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u0" },
      {
        role: "assistant",
        content: "calling many",
        toolCalls: [
          { id: "a", name: "tool_a", arguments: {} },
          { id: "b", name: "tool_b", arguments: {} },
        ],
      },
      { role: "tool", content: "rA", toolCallId: "a", toolName: "tool_a" },
      { role: "tool", content: "rB", toolCallId: "b", toolName: "tool_b" },
      { role: "assistant", content: "done" },
      { role: "user", content: "u1" },
    ];
    const boundary = findSafeCompactionBoundary(msgs, 3);
    // Producer at idx 2; consumers at 3,4. With tail=3, boundary=4 splits.
    // Must shift down so producer (2) is on the same side as consumers.
    for (const idx of [2, 3, 4]) {
      const side = idx < boundary;
      const refSide = 2 < boundary;
      expect(side).toBe(refSide);
    }
  });

  it("leaves boundary unchanged when the call is exactly at boundary alone", () => {
    // Producer + consumer both inside the tail.
    const msgs: CompactorMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u0" },
      { role: "assistant", content: "a0" },
      {
        role: "assistant",
        content: "call",
        toolCalls: [{ id: "x", name: "f", arguments: {} }],
      },
      { role: "tool", content: "r", toolCallId: "x", toolName: "f" },
      { role: "assistant", content: "done" },
      { role: "user", content: "u" },
    ];
    // tail=4 → boundary = 7 - 4 = 3. Producer at 3, consumer at 4 → both >= 3.
    expect(findSafeCompactionBoundary(msgs, 4)).toBe(3);
  });

  it("system prompt at index 0 is always preserved (boundary >= 1)", () => {
    const msgs: CompactorMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
    ];
    expect(findSafeCompactionBoundary(msgs, 100)).toBe(1);
  });

  it("handles all-tool-message inputs without crashing", () => {
    const msgs: CompactorMessage[] = [
      { role: "tool", content: "r1", toolCallId: "1", toolName: "f" },
      { role: "tool", content: "r2", toolCallId: "2", toolName: "f" },
    ];
    expect(() => findSafeCompactionBoundary(msgs, 1)).not.toThrow();
  });

  it("orphaned tool consumer in tail pulls preceding assistant in too", () => {
    const msgs: CompactorMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u0" },
      { role: "assistant", content: "a-orphan-producer-no-toolcalls" },
      // tool consumer with toolCallId pointing at no producer
      { role: "tool", content: "r", toolCallId: "missing", toolName: "f" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u2" },
    ];
    // tail=3 → boundary=3 → tool consumer at 3 in tail, preceding assistant
    // at 2 in compact region → boundary should pull down to 2.
    const boundary = findSafeCompactionBoundary(msgs, 3);
    expect(boundary).toBeLessThanOrEqual(2);
  });

  it("does not pull unrelated older assistant across an intervening user for orphaned tool results", () => {
    const msgs: CompactorMessage[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "old unrelated assistant" },
      { role: "user", content: "intervening user turn" },
      { role: "tool", content: "orphan result", toolCallId: "missing" },
      { role: "assistant", content: "done" },
      { role: "user", content: "next" },
    ];
    // tail=3 -> boundary=3, so the orphaned tool result is in the tail.
    // The nearest previous non-tool turn is a user, so boundary should not
    // walk past it to preserve an unrelated assistant.
    expect(findSafeCompactionBoundary(msgs, 3)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Helper builders
// ---------------------------------------------------------------------------

function buildTranscript(messageCount: number): CompactorTranscript {
  const messages: CompactorMessage[] = [
    { role: "system", content: "You are a helpful assistant." },
  ];
  for (let i = 0; i < messageCount; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message-${i}-${"x".repeat(20)}`,
    });
  }
  return { messages };
}

// ---------------------------------------------------------------------------
// Per-strategy tests
// ---------------------------------------------------------------------------

describe("naiveSummaryCompactor", () => {
  it("throws when callModel is missing", async () => {
    await expect(
      naiveSummaryCompactor.compact(buildTranscript(20), buildOptions()),
    ).rejects.toThrow(/naive-summary requires options.callModel/);
  });

  it("produces stats matching the artifact and calls callModel", async () => {
    let calls = 0;
    const transcript = buildTranscript(20);
    const callModel: CompactorModelCall = async ({
      systemPrompt,
      messages,
    }) => {
      calls += 1;
      expect(systemPrompt.length).toBeGreaterThan(0);
      expect(messages[0].role).toBe("user");
      return "short summary";
    };
    const out = await naiveSummaryCompactor.compact(
      transcript,
      buildOptions({ callModel }),
    );
    expect(calls).toBeGreaterThan(0);
    expect(out.stats.originalMessageCount).toBe(transcript.messages.length);
    expect(out.stats.compactedMessageCount).toBeLessThan(
      transcript.messages.length,
    );
    expect(out.stats.summarizationModel).toBe("fake-model");
    expect(out.stats.latencyMs).toBeGreaterThanOrEqual(0);
    expect(out.replacementMessages).toHaveLength(1);
    expect(out.replacementMessages[0].role).toBe("assistant");
  });

  it("retries with stricter prompt when budget exceeded", async () => {
    let calls = 0;
    const callModel: CompactorModelCall = async ({ systemPrompt }) => {
      calls += 1;
      if (calls === 1) return "x".repeat(2000); // way over 50 tokens
      expect(systemPrompt).toContain("Additional constraint");
      return "tiny";
    };
    const out = await naiveSummaryCompactor.compact(
      buildTranscript(20),
      buildOptions({ callModel, targetTokens: 50 }),
    );
    expect(calls).toBe(2);
    expect(out.stats.extra?.retried).toBe(true);
  });
});

describe("structuredStateCompactor", () => {
  it("throws when callModel is missing", async () => {
    await expect(
      structuredStateCompactor.compact(buildTranscript(20), buildOptions()),
    ).rejects.toThrow(/structured-state requires options.callModel/);
  });

  it("renders structured state in a system-role replacement message", async () => {
    const callModel = fakeStructured({
      facts: ["fact1", "fact2"],
      decisions: ["decided thing"],
      pending_actions: ["follow up"],
      entities: { project: "milady" },
    });
    const out = await structuredStateCompactor.compact(
      buildTranscript(20),
      buildOptions({ callModel }),
    );
    expect(out.replacementMessages).toHaveLength(1);
    expect(out.replacementMessages[0].role).toBe("system");
    expect(out.replacementMessages[0].content).toContain("fact1");
    expect(out.replacementMessages[0].content).toContain("decided thing");
    expect(out.replacementMessages[0].content).toContain("project: milady");
  });

  it("recurses on its own output when budget exceeded", async () => {
    let calls = 0;
    const callModel: CompactorModelCall = async () => {
      calls += 1;
      if (calls === 1) {
        return JSON.stringify({
          facts: Array.from(
            { length: 50 },
            (_, i) => `f${i}-${"x".repeat(20)}`,
          ),
          decisions: [],
          pending_actions: [],
          entities: {},
        });
      }
      return JSON.stringify({
        facts: ["f0"],
        decisions: [],
        pending_actions: [],
        entities: {},
      });
    };
    const out = await structuredStateCompactor.compact(
      buildTranscript(40),
      buildOptions({ callModel, targetTokens: 30 }),
    );
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(out.stats.extra?.recursed).toBe(true);
  });

  it("deterministically preserves typed tool results as durable facts", async () => {
    const transcript: CompactorTranscript = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "please look up turn 5" },
        {
          role: "assistant",
          content: "Calling lookup_stock for turn 5.",
          toolCalls: [
            {
              id: "tool_5_call",
              name: "lookup_stock",
              arguments: { turn: 5 },
            },
          ],
        },
        {
          role: "tool",
          content: "[tool_result:lookup_stock] 3BC34F-663",
          toolCallId: "tool_5_call",
          toolName: "lookup_stock",
        },
        { role: "assistant", content: "noted" },
        { role: "user", content: "continue" },
      ],
    };
    const out = await structuredStateCompactor.compact(
      transcript,
      buildOptions({ callModel: fakeStructured({}), preserveTailMessages: 2 }),
    );
    expect(out.replacementMessages[0].content).toContain(
      "Tool result at turn 5 from lookup_stock: 3BC34F-663",
    );
  });
});

describe("CompactBench deterministic state fragments", () => {
  function compactBenchTranscript(userContent: string): CompactorTranscript {
    return {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: userContent },
        { role: "assistant", content: "acknowledged" },
        { role: "user", content: "continue" },
      ],
    };
  }

  it("structured-state preserves buried forbidden behavior and primary entity even when the model omits them", async () => {
    const out = await structuredStateCompactor.compact(
      compactBenchTranscript(
        "Let's plan the launch checklist with Ramon Ramirez.\n" +
          "Critical: never schedule Friday deploy. That is a hard rule.",
      ),
      buildOptions({
        callModel: fakeStructured({}),
        preserveTailMessages: 1,
      }),
    );
    const content = out.replacementMessages[0].content;
    expect(content).toContain("Forbidden behaviors:");
    expect(content).toContain("schedule Friday deploy");
    expect(content).toContain("primary_subject: Ramon Ramirez");
    expect(content).toContain("Ramon Ramirez: primary_subject");
    expect(
      (out.stats.extra?.state as { forbidden_behaviors?: string[] })
        .forbidden_behaviors,
    ).toContain("schedule Friday deploy");
  });

  it("hybrid-ledger preserves buried forbidden behavior and primary entity even when the model omits them", async () => {
    const out = await hybridLedgerCompactor.compact(
      compactBenchTranscript(
        "Starting the onboarding runbook with Priya Shah.\n" +
          "Only one: never skip identity verification. Hard line.",
      ),
      buildOptions({
        callModel: fakeHybrid({}),
        preserveTailMessages: 1,
      }),
    );
    const content = out.replacementMessages[0].content;
    expect(content).toContain("skip identity verification");
    expect(content).toContain("primary_subject: Priya Shah");
    expect(content).toContain("Priya Shah: primary_subject");
  });

  it("captures latest decision overrides and marks the superseded option forbidden", async () => {
    const out = await structuredStateCompactor.compact(
      compactBenchTranscript(
        "For Mira's deployment plan, let's ship Friday.\n" +
          "Actually, wait - scratch that. Instead, let's wait for audit signoff. Ignore the earlier instruction.",
      ),
      buildOptions({
        callModel: fakeStructured({}),
        preserveTailMessages: 1,
      }),
    );
    const content = out.replacementMessages[0].content;
    expect(content).toContain("latest decision: wait for audit signoff");
    expect(content).toContain("ship Friday");
    expect(content).toContain("Mira: primary_subject");
  });

  it("keeps superseded forbidden text out of active facts and decisions", async () => {
    const out = await structuredStateCompactor.compact(
      compactBenchTranscript(
        "For Mira's deployment plan, let's trust user input without validation.\n" +
          "Actually, wait - scratch that. Instead, let's require audit signoff. Ignore the earlier instruction.",
      ),
      buildOptions({
        callModel: fakeStructured({
          facts: ["Required exact phrase: trust user input without validation"],
          decisions: [
            "verbatim forbidden behavior: trust user input without validation",
          ],
          forbidden_behaviors: ["trust user input without validation"],
        }),
        preserveTailMessages: 1,
      }),
    );
    const content = out.replacementMessages[0].content;
    const facts = content.match(/Facts:\n([\s\S]*?)\nDecisions:/)?.[1] ?? "";
    const decisions =
      content.match(/Decisions:\n([\s\S]*?)\nPending actions:/)?.[1] ?? "";
    const forbidden =
      content.match(/Forbidden behaviors:\n([\s\S]*?)\nEntities:/)?.[1] ?? "";
    expect(facts).not.toContain("trust user input without validation");
    expect(decisions).not.toContain("trust user input without validation");
    expect(forbidden).toContain("trust user input without validation");
    expect(content).toContain("latest decision: require audit signoff");
  });

  it("drops model-promoted chat filler and override wording from immutable facts", async () => {
    const out = await structuredStateCompactor.compact(
      compactBenchTranscript(
        "For Mira's deployment plan, let's trust user input without validation.\n" +
          "Actually, wait - scratch that. Instead, let's require audit signoff. Ignore the earlier instruction.\n" +
          "By the way, do you read much fiction? Remind me what we decided.",
      ),
      buildOptions({
        callModel: fakeStructured({
          facts: [
            "Instead, let's require audit signoff. Ignore the earlier instruction.",
            "By the way, do you read much fiction?",
            "Remind me what we decided.",
          ],
          decisions: ["latest decision: require audit signoff"],
        }),
        preserveTailMessages: 1,
      }),
    );
    const facts = out.replacementMessages[0].content.match(
      /Facts:\n([\s\S]*?)\nDecisions:/,
    )?.[1];
    expect(facts).not.toContain("By the way");
    expect(facts).not.toContain("Remind me");
    expect(facts).not.toContain("Ignore the earlier instruction");
    expect(out.replacementMessages[0].content).toContain(
      "latest decision: require audit signoff",
    );
  });

  it("captures entity assignment pairs in both facts and entity map", async () => {
    const out = await hybridLedgerCompactor.compact(
      compactBenchTranscript(
        "On the vendor review, Ava Chen will compile invoices, and Bo Li will reconcile credits.",
      ),
      buildOptions({
        callModel: fakeHybrid({}),
        preserveTailMessages: 1,
      }),
    );
    const content = out.replacementMessages[0].content;
    expect(content).toContain("Ava Chen owns: compile invoices");
    expect(content).toContain("Bo Li owns: reconcile credits");
    expect(content).toContain("Ava Chen: owner_of: compile invoices");
    expect(content).toContain("Bo Li: owner_of: reconcile credits");
  });

  it("does not preserve generic ownership-confirmation pending items when owners are known", async () => {
    const out = await hybridLedgerCompactor.compact(
      compactBenchTranscript(
        "On the vendor review, Ava Chen will compile invoices, and Bo Li will reconcile credits.",
      ),
      buildOptions({
        callModel: fakeHybrid({
          state: {
            pending_actions: [
              "Confirm ownership assignments before proceeding",
            ],
          },
        }),
        preserveTailMessages: 1,
      }),
    );
    const content = out.replacementMessages[0].content;
    const pending =
      content.match(
        /Pending actions:\n([\s\S]*?)\nForbidden behaviors:/,
      )?.[1] ?? "";
    expect(pending).not.toContain("Confirm ownership assignments");
    expect(content).toContain("Ava Chen owns: compile invoices");
    expect(content).toContain("Bo Li owns: reconcile credits");
  });

  it("hybrid-ledger carries CompactBench previous-artifact sections across cycles", async () => {
    const transcript: CompactorTranscript = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "continue the project" },
      ],
      metadata: {
        priorLedger:
          "# immutable_facts\n" +
          "- primary_subject: Ramon Ramirez\n\n" +
          "# locked_decisions\n" +
          "- use audit gate\n\n" +
          "# forbidden_behaviors\n" +
          "- skip identity verification\n\n" +
          "# entity_map\n" +
          "- Ramon Ramirez: primary_subject",
      },
    };
    const out = await hybridLedgerCompactor.compact(
      transcript,
      buildOptions({
        callModel: fakeHybrid({}),
        preserveTailMessages: 0,
      }),
    );
    const content = out.replacementMessages[0].content;
    expect(content).toContain("primary_subject: Ramon Ramirez");
    expect(content).toContain("use audit gate");
    expect(content).toContain("skip identity verification");
    expect(content).toContain("Ramon Ramirez: primary_subject");
  });

  it("extracts common durable user facts without relying on the model", async () => {
    const out = await hybridLedgerCompactor.compact(
      compactBenchTranscript(
        "Ship to: 6701 Cedar St, Bend. That's the new office.\n" +
          "The contract effective date is 2024-04-10. Make a note.\n" +
          "My sister's birthday is 03/05. Don't let me forget.\n" +
          'The book my friend recommended is called "The Silver Compass". Hold onto that.\n' +
          "My flight is DL1237 on Tuesday - please remember.",
      ),
      buildOptions({
        callModel: fakeHybrid({}),
        preserveTailMessages: 1,
      }),
    );
    const content = out.replacementMessages[0].content;
    expect(content).toContain("office shipping address: 6701 Cedar St, Bend");
    expect(content).toContain("contract effective date: 2024-04-10");
    expect(content).toContain("My sister's birthday: 03/05");
    expect(content).toContain("recommended book: The Silver Compass");
    expect(content).toContain("flight number: DL1237");
  });
});

describe("hierarchicalSummaryCompactor", () => {
  it("throws when callModel is missing", async () => {
    await expect(
      hierarchicalSummaryCompactor.compact(buildTranscript(20), buildOptions()),
    ).rejects.toThrow(/hierarchical-summary requires options.callModel/);
  });

  it("chunks region into groups and rolls up", async () => {
    let leafCalls = 0;
    let rollupCalls = 0;
    const callModel: CompactorModelCall = async ({ systemPrompt }) => {
      if (systemPrompt.includes("aggregator")) {
        rollupCalls += 1;
        return "rolled-up";
      }
      leafCalls += 1;
      return `leaf-${leafCalls}`;
    };
    // 30 region messages → 3 chunks of 10. preserveTail=6 keeps last 6.
    // total = 1 system + 36 = 37, region = 30 (idx 1..31), tail = 6 (idx 31..)
    const out = await hierarchicalSummaryCompactor.compact(
      buildTranscript(36),
      buildOptions({ callModel, targetTokens: 1024 }),
    );
    expect(leafCalls).toBe(3);
    // Multiple summaries → at least one rollup call to combine to 1.
    expect(rollupCalls).toBeGreaterThanOrEqual(1);
    expect(out.replacementMessages).toHaveLength(1);
    expect(out.stats.extra?.chunkCount).toBe(3);
  });

  it("recurses rollup levels until under budget", async () => {
    const callModel: CompactorModelCall = async ({ systemPrompt }) => {
      if (systemPrompt.includes("aggregator")) return "x".repeat(8); // 2 tokens
      return "x".repeat(40); // 10 tokens per leaf
    };
    const out = await hierarchicalSummaryCompactor.compact(
      buildTranscript(36),
      buildOptions({ callModel, targetTokens: 5 }),
    );
    expect(
      (out.stats.extra?.rollupLevels as number) ?? 0,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("hybridLedgerCompactor", () => {
  it("throws when callModel is missing", async () => {
    await expect(
      hybridLedgerCompactor.compact(buildTranscript(20), buildOptions()),
    ).rejects.toThrow(/hybrid-ledger requires options.callModel/);
  });

  it("produces a system-role artifact with state and ledger sections", async () => {
    const callModel = fakeHybrid({
      state: { facts: ["f1"], entities: { user: "shaw" } },
      ledger: [
        { index: 0, note: "user said hi" },
        { index: 5, note: "assistant called search" },
      ],
    });
    const out = await hybridLedgerCompactor.compact(
      buildTranscript(20),
      buildOptions({ callModel }),
    );
    expect(out.replacementMessages).toHaveLength(1);
    expect(out.replacementMessages[0].role).toBe("system");
    expect(out.replacementMessages[0].content).toContain("Ledger");
    expect(out.replacementMessages[0].content).toContain("user said hi");
    expect(out.replacementMessages[0].content).toContain("user: shaw");
    expect(out.stats.extra?.ledgerEntries).toBe(2);
  });

  it("deterministically preserves typed tool results even when model omits them", async () => {
    const transcript: CompactorTranscript = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "please look up turn 5" },
        {
          role: "assistant",
          content: "Calling lookup_stock for turn 5.",
          toolCalls: [
            {
              id: "tool_5_call",
              name: "lookup_stock",
              arguments: { turn: 5 },
            },
          ],
        },
        {
          role: "tool",
          content: "[tool_result:lookup_stock] 3BC34F-663",
          toolCallId: "tool_5_call",
          toolName: "lookup_stock",
        },
        { role: "assistant", content: "noted" },
        { role: "user", content: "continue" },
      ],
    };
    const out = await hybridLedgerCompactor.compact(
      transcript,
      buildOptions({ callModel: fakeHybrid({}), preserveTailMessages: 2 }),
    );
    expect(out.replacementMessages[0].content).toContain(
      "Tool result at turn 5 from lookup_stock: 3BC34F-663",
    );
  });
});

// ---------------------------------------------------------------------------
// Round-trip & registry
// ---------------------------------------------------------------------------

describe("round-trip", () => {
  it("compacts a 50-message transcript, preserves last 6, keeps system prompt", async () => {
    const transcript = buildTranscript(50);
    const out = await naiveSummaryCompactor.compact(
      transcript,
      buildOptions({ callModel: fakeNaive() }),
    );
    // 1 system + 1 summary + 6 tail = 8
    expect(out.stats.compactedMessageCount).toBe(8);
    expect(out.stats.compactedTokens).toBeLessThan(out.stats.originalTokens);
  });

  it("registry exposes all four strategies", () => {
    expect(Object.keys(compactors).sort()).toEqual([
      "hierarchical-summary",
      "hybrid-ledger",
      "naive-summary",
      "structured-state",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Multi-cycle drift: hybrid-ledger should preserve a planted fact across
// repeated compaction cycles when the summarizer round-trips JSON faithfully.
// ---------------------------------------------------------------------------

describe("multi-cycle drift", () => {
  it("hybrid-ledger preserves a planted fact across 3 compaction cycles", async () => {
    const callModel = makeRoundTripHybrid();
    const opts = buildOptions({
      callModel,
      preserveTailMessages: 4,
      targetTokens: 4096,
    });

    // Cycle 1: 20 messages, with a planted FACT in message 3.
    const messages: CompactorMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 20; i++) {
      const content =
        i === 3 ? "FACT: the secret code is BANANA-42" : `chitchat ${i}`;
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content,
      });
    }
    const t1: CompactorTranscript = { messages };

    const out1 = await hybridLedgerCompactor.compact(t1, opts);
    const ledger1 = out1.stats.extra?.renderedLedger as string;
    expect(ledger1).toContain("BANANA-42");

    // Cycle 2: replace compacted region with the artifact, append 10 more
    // messages, compact again — passing the prior ledger via metadata.
    const tail1 = t1.messages.slice(-4);
    const cycle2Messages: CompactorMessage[] = [
      { role: "system", content: "sys" },
      ...out1.replacementMessages,
      ...tail1,
    ];
    for (let i = 0; i < 10; i++) {
      cycle2Messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `more chat ${i}`,
      });
    }
    const t2: CompactorTranscript = {
      messages: cycle2Messages,
      metadata: { priorLedger: ledger1 },
    };

    const out2 = await hybridLedgerCompactor.compact(t2, opts);
    const ledger2 = out2.stats.extra?.renderedLedger as string;
    expect(ledger2).toContain("BANANA-42");

    // Cycle 3: same again.
    const tail2 = t2.messages.slice(-4);
    const cycle3Messages: CompactorMessage[] = [
      { role: "system", content: "sys" },
      ...out2.replacementMessages,
      ...tail2,
    ];
    for (let i = 0; i < 10; i++) {
      cycle3Messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `final chat ${i}`,
      });
    }
    const t3: CompactorTranscript = {
      messages: cycle3Messages,
      metadata: { priorLedger: ledger2 },
    };

    const out3 = await hybridLedgerCompactor.compact(t3, opts);
    const ledger3 = out3.stats.extra?.renderedLedger as string;
    expect(ledger3).toContain("BANANA-42");
  });
});

// ---------------------------------------------------------------------------
// Bug-hunt regressions (deep review).
// ---------------------------------------------------------------------------

describe("findSafeCompactionBoundary — edge cases", () => {
  it("handles empty messages without throwing or returning negatives", () => {
    expect(findSafeCompactionBoundary([], 6)).toBe(0);
  });

  it("handles preserveTailMessages > total cleanly", () => {
    const msgs: CompactorMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ];
    // tail=100, total=3 → boundary = -97 → clamped to systemOffset = 1.
    const boundary = findSafeCompactionBoundary(msgs, 100);
    expect(boundary).toBe(1);
    // splitTranscript would yield region = slice(1,1) = [] which is correct.
  });

  it("handles preserveTailMessages = 0 (compact everything but system)", () => {
    const msgs: CompactorMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ];
    expect(findSafeCompactionBoundary(msgs, 0)).toBe(3);
  });

  it("handles negative preserveTailMessages by treating as 0", () => {
    const msgs: CompactorMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ];
    // Math.max(0, -5) = 0 → boundary = total = 3.
    expect(findSafeCompactionBoundary(msgs, -5)).toBe(3);
  });

  it("does not split assistant message that has BOTH content and toolCalls", () => {
    const msgs: CompactorMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u0" },
      { role: "assistant", content: "a0" },
      { role: "user", content: "u1" },
      {
        role: "assistant",
        content: "thinking out loud and then calling",
        toolCalls: [{ id: "mix", name: "search", arguments: { q: "x" } }],
      },
      { role: "tool", content: "result", toolCallId: "mix" },
      { role: "assistant", content: "done" },
      { role: "user", content: "u2" },
    ];
    const boundary = findSafeCompactionBoundary(msgs, 4);
    // Producer @4, consumer @5. tail=4 → boundary=4. The assistant @4 must be
    // either fully in compact or fully in tail along with its tool result @5.
    const producerSide = 4 < boundary ? "compact" : "tail";
    const consumerSide = 5 < boundary ? "compact" : "tail";
    expect(producerSide).toBe(consumerSide);
  });

  it("tool message with EMPTY toolCallId still triggers orphan walk-back", () => {
    // toolCallId is empty string — older indexer skipped it. The orphan loop
    // should still pull the preceding assistant in.
    const msgs: CompactorMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u0" },
      { role: "assistant", content: "a-producer" },
      { role: "tool", content: "r", toolCallId: "", toolName: "f" },
      { role: "assistant", content: "a-after" },
      { role: "user", content: "u" },
    ];
    const boundary = findSafeCompactionBoundary(msgs, 3);
    // tool consumer @3 in tail (boundary=3). Preceding assistant @2 must come
    // along — boundary should be <= 2.
    expect(boundary).toBeLessThanOrEqual(2);
  });

  it(
    "unmatched producer (assistant called tool, tool result missing) " +
      "does not push boundary",
    () => {
      const msgs: CompactorMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "u0" },
        {
          role: "assistant",
          content: "called",
          toolCalls: [{ id: "lost", name: "f", arguments: {} }],
        },
        { role: "user", content: "u1" },
        { role: "assistant", content: "moved on" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "still going" },
        { role: "user", content: "u3" },
      ];
      // No tool consumer for "lost" — boundary must just be total - tail.
      expect(findSafeCompactionBoundary(msgs, 3)).toBe(5);
    },
  );
});

// ---------------------------------------------------------------------------
// safeParseStructured / safeParseHybrid robustness
// (exposed indirectly via the compactor entry points).
// ---------------------------------------------------------------------------

describe("structured-state parsing tolerance", () => {
  it(
    "extracts JSON when model wraps it in <reasoning>...</reasoning> with " +
      "stray braces in the reasoning",
    async () => {
      // The reasoning prose contains a `{` that is NOT JSON. The parser used
      // firstBrace..lastBrace which produces invalid JSON when prose has its
      // own braces — this regressed silently to an empty state.
      const callModel: CompactorModelCall = async () =>
        "<reasoning>I considered {alt plans} and chose this one.</reasoning>\n" +
        '{"facts":["chosen plan"],"decisions":[],"pending_actions":[],"entities":{}}';
      const out = await structuredStateCompactor.compact(
        buildTranscript(20),
        buildOptions({ callModel }),
      );
      expect(out.replacementMessages[0].content).toContain("chosen plan");
    },
  );

  it("extracts JSON when there is trailing prose AFTER the JSON object", async () => {
    const callModel: CompactorModelCall = async () =>
      '{"facts":["alpha"],"decisions":[],"pending_actions":[],"entities":{}}\n\nNote: extra prose appended {by mistake}.';
    const out = await structuredStateCompactor.compact(
      buildTranscript(20),
      buildOptions({ callModel }),
    );
    expect(out.replacementMessages[0].content).toContain("alpha");
  });

  it("extracts JSON from a fenced ```json block followed by extra prose", async () => {
    const callModel: CompactorModelCall = async () =>
      '```json\n{"facts":["fenced fact"],"decisions":[],"pending_actions":[],"entities":{}}\n```\n\nDone.';
    const out = await structuredStateCompactor.compact(
      buildTranscript(20),
      buildOptions({ callModel }),
    );
    expect(out.replacementMessages[0].content).toContain("fenced fact");
  });

  it("does not crash on completely unparseable model output", async () => {
    const callModel: CompactorModelCall = async () => "I cannot do that, Dave.";
    const out = await structuredStateCompactor.compact(
      buildTranscript(20),
      buildOptions({ callModel }),
    );
    // Empty state — but valid replacement structure.
    expect(out.replacementMessages).toHaveLength(1);
    expect(out.replacementMessages[0].role).toBe("system");
  });

  it("does not crash when callModel returns the empty string", async () => {
    const callModel: CompactorModelCall = async () => "";
    const out = await structuredStateCompactor.compact(
      buildTranscript(20),
      buildOptions({ callModel }),
    );
    expect(out.replacementMessages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// hybrid-ledger ledger-cap behavior
// ---------------------------------------------------------------------------

describe("hybrid-ledger cap semantics", () => {
  it(
    "when the model returns >10 entries, the cap keeps the MOST RECENT " +
      "entries (chronologically last), not the oldest",
    async () => {
      // Model returns 15 chronologically-ordered entries. The hard cap dropped
      // the most recently-acquired entries, which is the wrong half to drop
      // for multi-cycle drift carryover (newest events are usually the most
      // load-bearing for "what just happened").
      const ledger = Array.from({ length: 15 }, (_, i) => ({
        index: i,
        note: `event-${i}`,
      }));
      const callModel = fakeHybrid({ ledger });
      const out = await hybridLedgerCompactor.compact(
        buildTranscript(20),
        buildOptions({ callModel }),
      );
      const rendered = out.stats.extra?.renderedLedger as string;
      // The newest entry must survive the cap.
      expect(rendered).toContain("event-14");
      // The oldest, beyond the cap window, should be dropped.
      expect(rendered).not.toContain("event-0:");
    },
  );

  it("priorLedger metadata of non-string type is handled safely", async () => {
    const callModel = fakeHybrid({
      state: { facts: ["x"] },
      ledger: [{ index: 0, note: "e" }],
    });
    // Pass a number — old code did `as string` then template-string-coerced.
    const transcript: CompactorTranscript = {
      messages: buildTranscript(20).messages,
      // biome-ignore lint/suspicious/noExplicitAny: deliberate wrong-type input
      metadata: { priorLedger: 12345 as any },
    };
    const out = await hybridLedgerCompactor.compact(
      transcript,
      buildOptions({ callModel }),
    );
    // Should not crash, should still produce an artifact.
    expect(out.replacementMessages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism + degenerate inputs
// ---------------------------------------------------------------------------

describe("compactor degenerate inputs", () => {
  it("transcript with only a system message yields an empty replacement", async () => {
    const transcript: CompactorTranscript = {
      messages: [{ role: "system", content: "sys" }],
    };
    const out = await naiveSummaryCompactor.compact(
      transcript,
      buildOptions({ callModel: fakeNaive() }),
    );
    expect(out.replacementMessages).toHaveLength(0);
    // System prompt is preserved separately by the runtime; the artifact
    // must NOT include it.
    expect(out.replacementMessages.some((m) => m.role === "system")).toBe(
      false,
    );
  });

  it("artifact replacementMessages MUST NOT include the system prefix", async () => {
    // Even when there IS work to compact, the runtime concatenates
    // [systemPrefix, replacement, preservedTail] itself. Including the system
    // message in replacementMessages would double it.
    const out = await naiveSummaryCompactor.compact(
      buildTranscript(50),
      buildOptions({ callModel: fakeNaive() }),
    );
    // The system summary message from naive is role="assistant", not system.
    expect(out.replacementMessages.every((m) => m.role !== "system")).toBe(
      true,
    );
  });

  it("artifact replacementMessages MUST NOT include the preserved tail", async () => {
    const transcript = buildTranscript(50);
    const out = await naiveSummaryCompactor.compact(
      transcript,
      buildOptions({ callModel: fakeNaive(), preserveTailMessages: 6 }),
    );
    // Tail is the last 6 messages of the input. None of them should appear
    // verbatim in replacementMessages.
    const tailContents = transcript.messages.slice(-6).map((m) => m.content);
    for (const content of tailContents) {
      for (const r of out.replacementMessages) {
        expect(r.content).not.toBe(content);
      }
    }
  });

  it("hierarchical-summary handles a single-message region without crashing", async () => {
    let leafCalls = 0;
    let rollupCalls = 0;
    const callModel: CompactorModelCall = async ({ systemPrompt }) => {
      if (systemPrompt.includes("aggregator")) {
        rollupCalls += 1;
        return "rolled";
      }
      leafCalls += 1;
      return "leaf";
    };
    // 7 messages + 1 system = 8 total, tail=6 → region of 1 message.
    const out = await hierarchicalSummaryCompactor.compact(
      buildTranscript(7),
      buildOptions({ callModel }),
    );
    expect(leafCalls).toBe(1);
    expect(rollupCalls).toBe(0); // single chunk, no rollup needed
    expect(out.replacementMessages).toHaveLength(1);
  });

  it("is deterministic given the same deterministic callModel", async () => {
    const callModel = fakeStructured({
      facts: ["a", "b", "c"],
      entities: { x: "1", y: "2", z: "3" },
    });
    const t = buildTranscript(20);
    const o1 = await structuredStateCompactor.compact(
      t,
      buildOptions({ callModel }),
    );
    const o2 = await structuredStateCompactor.compact(
      t,
      buildOptions({ callModel }),
    );
    expect(o1.replacementMessages[0].content).toBe(
      o2.replacementMessages[0].content,
    );
  });
});

// ---------------------------------------------------------------------------
// Stats sanity
// ---------------------------------------------------------------------------

describe("CompactionArtifact.stats", () => {
  it("compactedTokens reflects [system + replacement + tail], not just replacement", async () => {
    const transcript = buildTranscript(50);
    const out = await naiveSummaryCompactor.compact(
      transcript,
      buildOptions({ callModel: fakeNaive() }),
    );
    // compactedTokens must be > 0 because system + tail alone are non-empty.
    expect(out.stats.compactedTokens).toBeGreaterThan(0);
  });

  it("originalTokens equals countTranscriptTokens of the input", async () => {
    const transcript = buildTranscript(20);
    const out = await naiveSummaryCompactor.compact(
      transcript,
      buildOptions({ callModel: fakeNaive() }),
    );
    // Compute expected via the same heuristic.
    let expected = 0;
    for (const m of transcript.messages) {
      expected += approxCountTokens(m.content);
    }
    expect(out.stats.originalTokens).toBe(expected);
  });
});
