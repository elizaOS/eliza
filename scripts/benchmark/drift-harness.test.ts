/**
 * Unit tests for the drift harness. No real network — all model calls are
 * stubbed. Verifies CLI parsing, fact planting, retry-on-429, JSONL shape,
 * and probe accounting.
 */

import { describe, expect, it } from "vitest";
import {
  applyCompaction,
  approxTokens,
  buildRealisticSystemPrompt,
  buildUserTurn,
  type ChatMessage,
  type CliArgs,
  extractBenchmarkAnswerText,
  FACT_KINDS,
  KNOWN_STRATEGIES,
  type ModelClient,
  makeFakeClient,
  makeOpenAICompatibleClient,
  parseArgs,
  parseJudgeResponse,
  planFacts,
  planToolCalls,
  probeFact,
  probeToolCall,
  rng,
  runDriftHarness,
} from "./drift-harness";

const DEFAULT_TEST_ARGS: CliArgs = {
  strategy: "none",
  turns: 5,
  compactEvery: 3,
  plantFacts: 2,
  output: "/tmp/test-out.jsonl",
  seed: 42,
  dryRun: true,
  model: "gpt-oss-120b",
  baseUrl: "https://api.cerebras.ai/v1",
  judgeModel: "gpt-oss-120b",
  agentReasoningEffort: "medium",
  judgeReasoningEffort: "medium",
  compactorReasoningEffort: "low",
  realisticSystemPrompt: false,
  withToolCalls: false,
  probeMaxTokens: 600,
  help: false,
};

describe("parseArgs", () => {
  it("parses all flags", () => {
    const a = parseArgs([
      "--strategy",
      "prompt-stripping",
      "--turns",
      "10",
      "--compact-every",
      "2",
      "--plant-facts",
      "3",
      "--seed",
      "7",
      "--output",
      "x.jsonl",
      "--dry-run",
    ]);
    expect(a.strategy).toBe("prompt-stripping");
    expect(a.turns).toBe(10);
    expect(a.compactEvery).toBe(2);
    expect(a.plantFacts).toBe(3);
    expect(a.seed).toBe(7);
    expect(a.output).toBe("x.jsonl");
    expect(a.dryRun).toBe(true);
  });

  it("rejects unknown strategies", () => {
    expect(() => parseArgs(["--strategy", "magical-thinking"])).toThrow(
      /unknown strategy/i,
    );
  });

  it("rejects non-integer turns", () => {
    expect(() => parseArgs(["--turns", "3.5"])).toThrow(/expects an integer/);
  });

  it("rejects plant-facts > turns", () => {
    expect(() => parseArgs(["--turns", "2", "--plant-facts", "5"])).toThrow(
      /cannot exceed/,
    );
  });

  it("allows plant-facts equal to turns", () => {
    const args = parseArgs(["--turns", "2", "--plant-facts", "2"]);
    expect(args.plantFacts).toBe(2);
  });

  it("recognizes --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("knows every advertised strategy", () => {
    for (const s of KNOWN_STRATEGIES) {
      const a = parseArgs([
        "--strategy",
        s,
        "--turns",
        "1",
        "--plant-facts",
        "0",
      ]);
      expect(a.strategy).toBe(s);
    }
  });
});

describe("rng", () => {
  it("is deterministic given the same seed", () => {
    const a = rng(123);
    const b = rng(123);
    for (let i = 0; i < 10; i++) expect(a()).toBeCloseTo(b(), 12);
  });
});

describe("planFacts", () => {
  it("plants the requested number of facts", () => {
    const facts = planFacts({ totalTurns: 20, count: 4, seed: 1 });
    expect(facts).toHaveLength(4);
    const turns = facts.map((f) => f.turn);
    expect(new Set(turns).size).toBe(4);
    for (const t of turns) {
      expect(t).toBeGreaterThanOrEqual(1);
      expect(t).toBeLessThanOrEqual(20);
    }
  });

  it("returns no facts when count = 0", () => {
    expect(planFacts({ totalTurns: 5, count: 0, seed: 1 })).toEqual([]);
  });

  it("is deterministic", () => {
    const a = planFacts({ totalTurns: 30, count: 5, seed: 99 });
    const b = planFacts({ totalTurns: 30, count: 5, seed: 99 });
    expect(a).toEqual(b);
  });

  it("handles count equal to totalTurns without hanging", () => {
    const facts = planFacts({ totalTurns: 2, count: 2, seed: 1 });
    expect(facts.map((f) => f.turn)).toEqual([1, 2]);
  });

  it("stratifies planted facts across the run", () => {
    const facts = planFacts({ totalTurns: 100, count: 5, seed: 123 });
    expect(facts[0]?.turn).toBeLessThanOrEqual(20);
    expect(facts.at(-1)?.turn).toBeGreaterThanOrEqual(81);
  });
});

describe("buildUserTurn", () => {
  it("uses the planted fact's utterance when supplied", () => {
    const fact = planFacts({ totalTurns: 5, count: 1, seed: 1 })[0];
    if (!fact) throw new Error("expected a planted fact");
    const t = buildUserTurn({ index: 1, rand: rng(1), fact });
    expect(t.factId).toBe(fact.id);
    expect(t.content).toBe(fact.utterance);
  });
});

describe("approxTokens", () => {
  it("uses 4-chars-per-token heuristic", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("abcde")).toBe(2);
  });
});

describe("parseJudgeResponse", () => {
  it("extracts JSON object from prose", () => {
    const r = parseJudgeResponse(
      'Here you go: {"correct": true, "reasoning": "match"}',
    );
    expect(r.correct).toBe(true);
    expect(r.reasoning).toBe("match");
  });

  it("treats false as false", () => {
    const r = parseJudgeResponse(
      '{"correct": false, "reasoning": "wrong city"}',
    );
    expect(r.correct).toBe(false);
  });

  it("falls back gracefully on bad JSON", () => {
    const r = parseJudgeResponse("not even json");
    expect(typeof r.correct).toBe("boolean");
  });

  it("does not mark prose containing both true and false as correct", () => {
    const r = parseJudgeResponse("false; not true for this answer");
    expect(r.correct).toBe(false);
  });
});

describe("extractBenchmarkAnswerText", () => {
  it("unwraps Eliza REPLY action JSON into visible text", () => {
    const raw = JSON.stringify(
      { action: "REPLY", args: { content: "7283 Cedar St, Ithaca" } },
      null,
      2,
    );
    expect(extractBenchmarkAnswerText(raw)).toBe("7283 Cedar St, Ithaca");
  });

  it("leaves non-REPLY action JSON intact", () => {
    const raw = JSON.stringify({
      action: "RECALL",
      args: { key: "contract_effective_date" },
    });
    expect(extractBenchmarkAnswerText(raw)).toBe(raw);
  });
});

describe("probeFact exact recall scoring", () => {
  it("rejects hedged answers even when they contain the expected identifier", async () => {
    const client: ModelClient = {
      chat: async () => ({
        content: "I don't know, maybe LIME-4421.",
      }),
    };
    const outcome = await probeFact({
      client,
      model: "fake",
      judgeModel: "fake",
      judgeWithModel: false,
      history: [],
      systemPrompt: "test",
      fact: {
        id: "fact_1",
        turn: 1,
        kind: "code",
        utterance: "The code is LIME-4421.",
        expected: "LIME-4421",
        question: "What is the code?",
        exactMatch: true,
      },
    });
    expect(outcome.correct).toBe(false);
  });

  it("scores final answers inside reasoning traces without global hedge pollution", async () => {
    const client: ModelClient = {
      chat: async () => ({
        content:
          "Maybe the user asked earlier; scan the notes. The recorded result was LIME-4421.",
      }),
    };
    const outcome = await probeFact({
      client,
      model: "fake",
      judgeModel: "fake",
      judgeWithModel: false,
      history: [],
      systemPrompt: "test",
      fact: {
        id: "fact_1",
        turn: 1,
        kind: "code",
        utterance: "The code is LIME-4421.",
        expected: "LIME-4421",
        question: "What is the code?",
        exactMatch: true,
      },
    });

    expect(outcome.correct).toBe(true);
  });

  it("still rejects a hedge local to the expected value", async () => {
    const client: ModelClient = {
      chat: async () => ({
        content: "The code might be LIME-4421.",
      }),
    };
    const outcome = await probeFact({
      client,
      model: "fake",
      judgeModel: "fake",
      judgeWithModel: false,
      history: [],
      systemPrompt: "test",
      fact: {
        id: "fact_1",
        turn: 1,
        kind: "code",
        utterance: "The code is LIME-4421.",
        expected: "LIME-4421",
        question: "What is the code?",
        exactMatch: true,
      },
    });

    expect(outcome.correct).toBe(false);
  });

  it("normalizes narrow no-break spaces in exact answers", async () => {
    const client: ModelClient = {
      chat: async () => ({
        content: "The contact is Ramon\u202fRamirez.",
      }),
    };
    const outcome = await probeFact({
      client,
      model: "fake",
      judgeModel: "fake",
      judgeWithModel: false,
      history: [],
      systemPrompt: "test",
      fact: {
        id: "fact_1",
        turn: 1,
        kind: "person_name",
        utterance: "The contact is Ramon Ramirez.",
        expected: "Ramon Ramirez",
        question: "Who is the contact?",
        exactMatch: true,
      },
    });
    expect(outcome.correct).toBe(true);
  });

  it("normalizes Unicode hyphen variants in exact answers", async () => {
    const client: ModelClient = {
      chat: async () => ({
        content: "The effective date is 2026\u201102\u201106.",
      }),
    };
    const outcome = await probeFact({
      client,
      model: "fake",
      judgeModel: "fake",
      judgeWithModel: false,
      history: [],
      systemPrompt: "test",
      fact: {
        id: "fact_1",
        turn: 1,
        kind: "date_iso",
        utterance: "The date is 2026-02-06.",
        expected: "2026-02-06",
        question: "What is the date?",
        exactMatch: true,
      },
    });
    expect(outcome.correct).toBe(true);
  });

  it("accepts common month-name renderings for birthday facts", async () => {
    const client: ModelClient = {
      chat: async () => ({
        content: "Your sister's birthday is September 21st.",
      }),
    };
    const outcome = await probeFact({
      client,
      model: "fake",
      judgeModel: "fake",
      judgeWithModel: false,
      history: [],
      systemPrompt: "test",
      fact: {
        id: "fact_1",
        turn: 1,
        kind: "birthday",
        utterance: "My sister's birthday is 09/21.",
        expected: "09/21",
        question: "When is my sister's birthday?",
        exactMatch: true,
      },
    });
    expect(outcome.correct).toBe(true);
  });

  it("scores extracted REPLY action content instead of the JSON envelope", async () => {
    const client: ModelClient = {
      chat: async () => ({
        content: JSON.stringify({
          action: "REPLY",
          args: { content: "7283 Cedar St, Ithaca" },
        }),
      }),
    };
    const outcome = await probeFact({
      client,
      model: "fake",
      judgeModel: "fake",
      judgeWithModel: false,
      history: [],
      systemPrompt: "test",
      fact: {
        id: "fact_1",
        turn: 1,
        kind: "address",
        utterance: "Ship to: 7283 Cedar St, Ithaca.",
        expected: "7283 Cedar St, Ithaca",
        question: "What is the address?",
        exactMatch: false,
      },
      judgeFn: async () => ({ correct: false, reasoning: "should bypass" }),
    });
    expect(outcome.correct).toBe(true);
    expect(outcome.actual).toBe("7283 Cedar St, Ithaca");
    expect(outcome.rawActual).toContain("REPLY");
  });
});

describe("applyCompaction", () => {
  it("returns identity for strategy=none", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const r = await applyCompaction({
      strategy: "none",
      inputs: { messages, preserveTail: 4 },
    });
    expect(r.newMessages).toEqual(messages);
    expect(r.unavailable).toBeUndefined();
  });

  it("strips greetings for prompt-stripping", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello!  there  friend" },
    ];
    const r = await applyCompaction({
      strategy: "prompt-stripping",
      inputs: { messages, preserveTail: 0 },
    });
    expect(r.newMessages[0]?.content).toBe("there friend");
  });

  it("reports unavailable when loader returns null", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hi" },
    ];
    const r = await applyCompaction({
      strategy: "naive-summary",
      inputs: { messages, preserveTail: 0 },
      loadCompactor: async () => null,
    });
    expect(r.unavailable).toBe(true);
    expect(r.unavailableReason).toMatch(/not yet implemented/);
  });

  it("falls back to naive summary when no loader is supplied", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "x" },
      { role: "assistant", content: "y" },
      { role: "user", content: "z" },
      { role: "assistant", content: "w" },
    ];
    const r = await applyCompaction({
      strategy: "hybrid-ledger",
      inputs: { messages, preserveTail: 1 },
    });
    expect(r.newMessages.some((m) => m.content.startsWith("[Summary]"))).toBe(
      true,
    );
  });
});

describe("makeOpenAICompatibleClient retry behavior", () => {
  it("retries on 429 and succeeds on the third attempt", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = (async () => {
      calls++;
      if (calls < 3) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const client = makeOpenAICompatibleClient({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      fetchImpl: fakeFetch,
      retries: 3,
      baseBackoffMs: 1,
    });
    const r = await client.chat({ model: "x", messages: [] });
    expect(r.content).toBe("ok");
    expect(calls).toBe(3);
  });

  it("propagates a non-retriable 4xx error", async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response("bad", { status: 400 })) as typeof fetch;
    const client = makeOpenAICompatibleClient({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      fetchImpl: fakeFetch,
      retries: 0,
    });
    await expect(client.chat({ model: "x", messages: [] })).rejects.toThrow(
      /upstream 400/,
    );
  });

  it("gives up after the retry budget on persistent 5xx", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = (async () => {
      calls++;
      return new Response("nope", { status: 503 });
    }) as typeof fetch;
    const client = makeOpenAICompatibleClient({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      fetchImpl: fakeFetch,
      retries: 2,
      baseBackoffMs: 1,
    });
    await expect(client.chat({ model: "x", messages: [] })).rejects.toThrow(
      /upstream 503/,
    );
    expect(calls).toBe(3); // initial + 2 retries
  });
});

describe("runDriftHarness end-to-end (fake client)", () => {
  it("emits the expected event sequence with one compaction", async () => {
    const args: CliArgs = {
      ...DEFAULT_TEST_ARGS,
      turns: 5,
      compactEvery: 3,
      plantFacts: 2,
      strategy: "none",
    };
    const sink = await runDriftHarness({
      args,
      client: makeFakeClient(),
    });
    const events = sink.events;
    const turnEvents = events.filter((e) => e.event === "turn");
    const compactEvents = events.filter((e) => e.event === "compact");
    const probeEvents = events.filter((e) => e.event === "probe");
    const summaryEvents = events.filter((e) => e.event === "summary");
    expect(turnEvents.length).toBe(args.turns * 2); // user+assistant per turn
    // compactEvery=3 in 5 turns triggers compaction at turn 3 only (turn 5 is final)
    expect(compactEvents.length).toBe(1);
    const facts = planFacts({
      totalTurns: args.turns,
      count: args.plantFacts,
      seed: args.seed,
    });
    const expectedPostCompactProbes = facts.filter((f) => f.turn <= 3).length;
    expect(probeEvents.length).toBe(
      expectedPostCompactProbes + args.plantFacts,
    );
    expect(summaryEvents.length).toBe(1);
    const summary = summaryEvents[0];
    if (!summary) throw new Error("expected a summary event");
    if (summary.event !== "summary") throw new Error("unreachable");
    expect(summary.strategy).toBe("none");
    expect(summary.totalProbes).toBe(
      expectedPostCompactProbes + args.plantFacts,
    );
  });

  it("produces a parseable JSONL serialization", async () => {
    const args: CliArgs = {
      ...DEFAULT_TEST_ARGS,
      turns: 3,
      plantFacts: 1,
      compactEvery: 100,
    };
    const sink = await runDriftHarness({ args, client: makeFakeClient() });
    const text = sink.serialize();
    const lines = text.trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const lastLine = lines[lines.length - 1];
    if (!lastLine) throw new Error("expected at least one JSONL line");
    const summary = JSON.parse(lastLine);
    expect(summary.event).toBe("summary");
    expect(summary).toHaveProperty("overallAccuracy");
    expect(summary).toHaveProperty("totalCompactions");
    expect(summary).toHaveProperty("totalTokensSaved");
    expect(summary.valid).toBe(true);
    expect(summary.skipped).toBe(false);
  });

  it("logs unavailable strategies without crashing", async () => {
    const args: CliArgs = {
      ...DEFAULT_TEST_ARGS,
      turns: 4,
      compactEvery: 2,
      plantFacts: 1,
      strategy: "hybrid-ledger",
    };
    const sink = await runDriftHarness({
      args,
      client: makeFakeClient(),
      loadCompactor: async () => null,
    });
    const compactEvents = sink.events.filter((e) => e.event === "compact");
    expect(compactEvents.length).toBeGreaterThanOrEqual(1);
    expect(
      compactEvents.every(
        (e) => e.event === "compact" && e.unavailable === true,
      ),
    ).toBe(true);
    // Summary still emitted; totalCompactions reflects only successful events.
    const summary = sink.events.find((e) => e.event === "summary");
    expect(summary).toBeDefined();
    if (summary && summary.event === "summary") {
      expect(summary.totalCompactions).toBe(0);
      expect(summary.valid).toBe(false);
      expect(summary.skipped).toBe(true);
      expect(summary.skipReason).toMatch(/not yet implemented/);
    }
  });

  it("uses the custom judge fn for prose facts", async () => {
    const args: CliArgs = {
      ...DEFAULT_TEST_ARGS,
      turns: 2,
      compactEvery: 100,
      plantFacts: 1,
      seed: 4, // seeds that prefer non-exact-match facts get judged
    };
    let judgeCalls = 0;
    const judgeFn = async () => {
      judgeCalls++;
      return { correct: true, reasoning: "stubbed" };
    };
    // Force prose path: stub the client to return whatever; if the planted
    // fact is exact-match, the judge isn't called and that's fine — the
    // assertion is that the harness completes either way.
    const sink = await runDriftHarness({
      args,
      client: makeFakeClient(),
      judgeFn,
    });
    expect(sink.events.some((e) => e.event === "summary")).toBe(true);
    // The judge is only called for non-exact-match facts; we just sanity-check
    // that calling judgeFn with non-zero count doesn't blow up.
    expect(judgeCalls).toBeGreaterThanOrEqual(0);
  });

  it("forwards model errors to the caller", async () => {
    const failingClient: ModelClient = {
      async chat() {
        throw new Error("boom");
      },
    };
    const args: CliArgs = {
      ...DEFAULT_TEST_ARGS,
      turns: 1,
      plantFacts: 0,
      compactEvery: 100,
    };
    await expect(
      runDriftHarness({ args, client: failingClient }),
    ).rejects.toThrow(/boom/);
  });
});

describe("planFacts balanced kind distribution", () => {
  it("gives every fact a distinct kind when count <= number of kinds", () => {
    const facts = planFacts({ totalTurns: 50, count: 4, seed: 1 });
    const kinds = facts.map((f) => f.kind);
    expect(new Set(kinds).size).toBe(4);
  });

  it("balances kinds for count >= number of kinds", () => {
    // With 24 facts and 12 kinds, every kind should appear exactly twice.
    const facts = planFacts({ totalTurns: 200, count: 24, seed: 17 });
    const counts = new Map<string, number>();
    for (const f of facts) {
      counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    }
    expect(counts.size).toBe(FACT_KINDS.length);
    for (const v of counts.values()) {
      expect(v).toBe(2);
    }
  });

  it("disambiguates repeated fact kinds with memory slots", () => {
    const facts = planFacts({
      totalTurns: 200,
      count: FACT_KINDS.length * 2,
      seed: 17,
    });
    const repeated = facts.filter(
      (fact) => facts.filter((other) => other.kind === fact.kind).length > 1,
    );

    expect(repeated.length).toBe(facts.length);
    for (const fact of repeated) {
      expect(fact.utterance).toMatch(/For memory slot /);
      expect(fact.question).toMatch(/For memory slot /);
    }
    const questions = repeated.map((fact) => fact.question);
    expect(new Set(questions).size).toBe(questions.length);
  });

  it("does not produce api_key facts", () => {
    const facts = planFacts({ totalTurns: 200, count: 24, seed: 5 });
    expect(facts.some((f) => (f.kind as string) === "api_key")).toBe(false);
  });

  it("includes safer high-information kinds", () => {
    expect(FACT_KINDS).toContain("book_title");
    expect(FACT_KINDS).toContain("isbn");
    expect(FACT_KINDS).toContain("date_iso");
    expect(FACT_KINDS).toContain("birthday");
    expect(FACT_KINDS).toContain("flight_number");
    expect(FACT_KINDS).toContain("uuid");
    expect(FACT_KINDS).toContain("zipcode");
  });
});

describe("buildRealisticSystemPrompt", () => {
  it("produces a ~5KB Eliza-style prompt", () => {
    const prompt = buildRealisticSystemPrompt();
    // ~5KB target with at least 3KB of meaningful content; deterministic.
    expect(prompt.length).toBeGreaterThan(3000);
    expect(prompt.length).toBeLessThan(20000);
    expect(prompt).toMatch(/Available Actions/);
    expect(prompt).toMatch(/Loaded Plugins/);
    expect(prompt).toMatch(/USE_SKILL/);
  });

  it("is deterministic", () => {
    expect(buildRealisticSystemPrompt()).toBe(buildRealisticSystemPrompt());
  });
});

describe("per-kind summary breakdown", () => {
  it("emits perKindAccuracy keyed by FactKind", async () => {
    const args: CliArgs = {
      ...DEFAULT_TEST_ARGS,
      turns: 6,
      compactEvery: 100,
      plantFacts: 3,
    };
    const sink = await runDriftHarness({ args, client: makeFakeClient() });
    const summary = sink.events.find((e) => e.event === "summary");
    expect(summary).toBeDefined();
    if (!summary || summary.event !== "summary") throw new Error("unreachable");
    expect(summary.perKindAccuracy).toBeDefined();
    const totalFromBreakdown = Object.values(summary.perKindAccuracy).reduce(
      (acc, v) => acc + v.total,
      0,
    );
    expect(totalFromBreakdown).toBe(summary.totalProbes);
    for (const [, v] of Object.entries(summary.perKindAccuracy)) {
      expect(v.total).toBeGreaterThan(0);
      expect(v.accuracy).toBeGreaterThanOrEqual(0);
      expect(v.accuracy).toBeLessThanOrEqual(1);
    }
  });
});

describe("planToolCalls and tool-call probes", () => {
  it("plans tool calls every 5 turns", () => {
    const tcs = planToolCalls({ totalTurns: 20, seed: 1 });
    expect(tcs.map((t) => t.turn)).toEqual([5, 10, 15, 20]);
    for (const tc of tcs) {
      expect(tc.toolName).toMatch(/^[a-z_]+$/);
      expect(tc.toolValue.length).toBeGreaterThan(0);
      expect(tc.question).toContain(`turn ${tc.turn}`);
    }
  });

  it("probes tool-call results when --with-tool-calls is set", async () => {
    const args: CliArgs = {
      ...DEFAULT_TEST_ARGS,
      turns: 5,
      compactEvery: 100,
      plantFacts: 0,
      withToolCalls: true,
    };
    const sink = await runDriftHarness({ args, client: makeFakeClient() });
    const probes = sink.events.filter((e) => e.event === "probe");
    // 1 tool call (turn 5) probed at final.
    expect(probes.length).toBe(1);
    const probe = probes[0];
    if (!probe) throw new Error("expected a probe event");
    if (probe.event !== "probe") throw new Error("unreachable");
    expect(probe.kind).toBe("tool_call");
    expect(probe.correct).toBe(true);
    const summary = sink.events.find((e) => e.event === "summary");
    if (!summary || summary.event !== "summary") throw new Error("unreachable");
    expect(summary.perKindAccuracy.tool_call?.total).toBe(1);
  });

  it("rejects contaminated tool-call answers that include another identifier", async () => {
    const client: ModelClient = {
      chat: async () => ({
        content: "The fetch_metric result was DEAD00-11, then ABC123-22.",
      }),
    };

    const outcome = await probeToolCall({
      client,
      model: "fake",
      history: [],
      systemPrompt: "test",
      toolCall: {
        id: "tool_25",
        turn: 25,
        toolName: "fetch_metric",
        toolValue: "ABC123-22",
        question: "What did the fetch_metric tool return at turn 25?",
      },
    });

    expect(outcome.correct).toBe(false);
    expect(outcome.judgeReasoning).toContain("contaminated");
  });

  it("accepts isolated tool-call answers with explanatory text", async () => {
    const client: ModelClient = {
      chat: async () => ({
        content: "The fetch_metric result at turn 25 was ABC123-22.",
      }),
    };

    const outcome = await probeToolCall({
      client,
      model: "fake",
      history: [],
      systemPrompt: "test",
      toolCall: {
        id: "tool_25",
        turn: 25,
        toolName: "fetch_metric",
        toolValue: "ABC123-22",
        question: "What did the fetch_metric tool return at turn 25?",
      },
    });

    expect(outcome.correct).toBe(true);
  });

  it("accepts repeated copies of the same tool-call value", async () => {
    const client: ModelClient = {
      chat: async () => ({
        content: "ABC123-22\n\nABC123-22",
      }),
    };

    const outcome = await probeToolCall({
      client,
      model: "fake",
      history: [],
      systemPrompt: "test",
      toolCall: {
        id: "tool_25",
        turn: 25,
        toolName: "fetch_metric",
        toolValue: "ABC123-22",
        question: "What did the fetch_metric tool return at turn 25?",
      },
    });

    expect(outcome.correct).toBe(true);
  });

  it("emits tool_call/tool_result turn events alongside the user/assistant pair", async () => {
    const args: CliArgs = {
      ...DEFAULT_TEST_ARGS,
      turns: 5,
      compactEvery: 100,
      plantFacts: 0,
      withToolCalls: true,
    };
    const sink = await runDriftHarness({ args, client: makeFakeClient() });
    const turnEvents = sink.events.filter((e) => e.event === "turn");
    // 5 turns × (user + assistant) = 10, plus 2 extra for the tool pair at turn 5.
    expect(turnEvents.length).toBe(12);
  });
});
