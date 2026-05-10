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
  entities?: Record<string, string>;
}): CompactorModelCall {
  const payload = JSON.stringify({
    facts: state.facts ?? [],
    decisions: state.decisions ?? [],
    pending_actions: state.pending_actions ?? [],
    entities: state.entities ?? {},
  });
  return async () => payload;
}

function fakeHybrid(payload: {
  state?: {
    facts?: string[];
    decisions?: string[];
    pending_actions?: string[];
    entities?: Record<string, string>;
  };
  ledger?: Array<{ index: number; note: string }>;
}): CompactorModelCall {
  const out = JSON.stringify({
    state: {
      facts: payload.state?.facts ?? [],
      decisions: payload.state?.decisions ?? [],
      pending_actions: payload.state?.pending_actions ?? [],
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
      /Existing ledger[\s\S]*?(?=\n\nNew conversation|\Z)/,
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
          facts: Array.from({ length: 50 }, (_, i) => `f${i}-${"x".repeat(20)}`),
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
});

describe("hierarchicalSummaryCompactor", () => {
  it("throws when callModel is missing", async () => {
    await expect(
      hierarchicalSummaryCompactor.compact(
        buildTranscript(20),
        buildOptions(),
      ),
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
    expect((out.stats.extra?.rollupLevels as number) ?? 0).toBeGreaterThanOrEqual(1);
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
    const messages: CompactorMessage[] = [
      { role: "system", content: "sys" },
    ];
    for (let i = 0; i < 20; i++) {
      const content =
        i === 3
          ? "FACT: the secret code is BANANA-42"
          : `chitchat ${i}`;
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
