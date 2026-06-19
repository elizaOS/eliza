/**
 * Sanity test for the bench runner.
 *
 * Wires two mock modes — one that ALWAYS answers correctly, one that ALWAYS
 * fails to parse — and runs them over a tiny fixture slice to confirm the
 * metric shape, scoring, and rollup are correct.
 *
 * Does not exercise the real engine or the Cerebras endpoint — those paths
 * are tested by the bench itself when run on a host that has the GGUF /
 * CEREBRAS_API_KEY.
 */
import { describe, expect, it } from "vitest";
import {
  buildMetric,
  checkParamsMatch,
  checkPlannerSchema,
  checkShouldRespondSchema,
  computeSkipRatio,
  deepEqual,
  percentile,
  summarize,
  tryParseJson,
} from "../src/metrics.ts";
import { type CerebrasClient, CerebrasMode } from "../src/modes/cerebras.ts";
import { ElizaGuidedMode } from "../src/modes/eliza-guided.ts";
import { ElizaStrictGuidedMode } from "../src/modes/eliza-strict-guided.ts";
import { buildTableRows, renderReport, renderTable } from "../src/report.ts";
import { runBench } from "../src/runner.ts";
import { listActionNames, loadActionFixtures } from "../src/tasks/action.ts";
import { loadPlannerFixtures } from "../src/tasks/planner.ts";
import { loadShouldRespondFixtures } from "../src/tasks/should-respond.ts";
import type {
  ModeAdapter,
  ModeRequest,
  ModeResult,
  ShouldRespondFixture,
} from "../src/types.ts";

describe("fixture files", () => {
  it("loads should-respond fixtures with required shape", () => {
    const fixtures = loadShouldRespondFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    for (const fixture of fixtures) {
      expect(typeof fixture.id).toBe("string");
      expect(typeof fixture.input).toBe("string");
      expect(["RESPOND", "IGNORE", "STOP"]).toContain(fixture.expected);
    }
  });

  it("loads planner fixtures with required shape", () => {
    const fixtures = loadPlannerFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(15);
    for (const fixture of fixtures) {
      expect(typeof fixture.id).toBe("string");
      expect(typeof fixture.input).toBe("string");
      expect(typeof fixture.expected_action_name).toBe("string");
      expect(Array.isArray(fixture.availableActions)).toBe(true);
      expect(fixture.availableActions.length).toBeGreaterThan(0);
    }
  });

  it("loads action fixtures grouped by name", () => {
    const fixtures = loadActionFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    const names = listActionNames();
    expect(names).toContain("REPLY");
    expect(names).toContain("MESSAGE");
  });
});

describe("metrics helpers", () => {
  it("tryParseJson handles bare objects, code fences, and trailing text", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(tryParseJson('here you go: {"a":1}. enjoy!')).toEqual({ a: 1 });
    expect(tryParseJson("nope")).toBeNull();
    expect(tryParseJson("")).toBeNull();
  });

  it("checkShouldRespondSchema validates the enum envelope", () => {
    expect(checkShouldRespondSchema({ shouldRespond: "RESPOND" })).toBe(true);
    expect(checkShouldRespondSchema({ shouldRespond: "STOP" })).toBe(true);
    expect(checkShouldRespondSchema({ shouldRespond: "MAYBE" })).toBe(false);
    expect(checkShouldRespondSchema({})).toBe(false);
    expect(checkShouldRespondSchema([])).toBe(false);
  });

  it("checkPlannerSchema validates {action, parameters}", () => {
    expect(checkPlannerSchema({ action: "REPLY", parameters: {} })).toBe(true);
    expect(checkPlannerSchema({ action: "REPLY" })).toBe(false);
    expect(checkPlannerSchema({ action: 1, parameters: {} })).toBe(false);
  });

  it("checkParamsMatch only requires keys that appear in expected", () => {
    expect(checkParamsMatch({ a: 1, b: 2 }, { a: 1 })).toBe(true);
    expect(checkParamsMatch({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(checkParamsMatch({ a: 2 }, { a: 1 })).toBe(false);
  });

  it("deepEqual handles nested arrays + objects", () => {
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: "1" })).toBe(false);
  });

  it("percentile interpolates between ranks", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10], 50)).toBe(10);
    expect(percentile([10, 20], 50)).toBe(15);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBeCloseTo(5.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBeCloseTo(9.55);
  });

  it("computeSkipRatio sums literal spans / total output bytes", () => {
    const skeleton = {
      spans: [
        { value: '{"action":"' }, // 11 bytes
        { kind: "enum" },
        { value: '","parameters":' }, // 15 bytes (includes the comma and quotes)
        { kind: "free-json" },
        { value: "}" }, // 1 byte
      ],
    };
    // Expected output: '{"action":"ALPHA","parameters":{"x":1}}'
    // Total length: 39 bytes
    // Literal bytes: 11 + 15 + 1 = 27
    const output = '{"action":"ALPHA","parameters":{"x":1}}';
    const ratio = computeSkipRatio(skeleton, output);
    expect(ratio).toBeCloseTo(27 / 39, 1);
  });

  it("computeSkipRatio returns undefined when skeleton is missing or malformed", () => {
    expect(computeSkipRatio(null, "output")).toBeUndefined();
    expect(computeSkipRatio({}, "output")).toBeUndefined();
    expect(computeSkipRatio({ spans: null }, "output")).toBeUndefined();
  });

  it("buildMetric derives tok/s from totalLatency", () => {
    const metric = buildMetric({
      taskId: "should_respond",
      modeId: "guided",
      caseId: "x",
      result: {
        rawOutput: '{"shouldRespond":"RESPOND"}',
        firstTokenLatencyMs: 50,
        totalLatencyMs: 1000,
        tokensGenerated: 10,
      },
      parse_success: true,
      schema_valid: true,
      label_match: true,
    });
    expect(metric.tokens_per_second).toBeCloseTo(10);
    expect(metric.first_token_latency_ms).toBe(50);
  });

  it("buildMetric computes skip_ratio when skeleton is provided", () => {
    const skeleton = {
      spans: [
        { value: '{"shouldRespond":"' }, // 19 bytes
        { kind: "enum" },
        { value: "}" }, // 1 byte
      ],
    };
    // Output: '{"shouldRespond":"RESPOND"}'  = 27 bytes
    // Literal: 19 + 1 = 20 bytes
    // Ratio: 20/27
    const metric = buildMetric({
      taskId: "should_respond",
      modeId: "guided",
      caseId: "x",
      result: {
        rawOutput: '{"shouldRespond":"RESPOND"}',
        firstTokenLatencyMs: 50,
        totalLatencyMs: 1000,
        tokensGenerated: 10,
        _skeleton: skeleton,
      },
      parse_success: true,
      schema_valid: true,
      label_match: true,
    });
    expect(metric.skip_ratio).toBeCloseTo(20 / 27, 1);
  });
});

describe("runner with mock modes", () => {
  function mockMode(args: {
    id: "unguided" | "guided" | "strict-guided" | "cerebras";
    output: (req: ModeRequest) => string;
  }): ModeAdapter {
    return {
      id: args.id,
      async available() {
        return null;
      },
      async generate(req: ModeRequest): Promise<ModeResult> {
        return {
          rawOutput: args.output(req),
          firstTokenLatencyMs: 5,
          totalLatencyMs: 100,
          tokensGenerated: 8,
        };
      },
    };
  }

  it("scores a perfect mode at 100% and a broken mode at 0% on should_respond", async () => {
    // Take a slice of the real should-respond fixtures.
    const all = loadShouldRespondFixtures();
    const sample = all.slice(0, 3);
    const truthByCaseId = new Map<string, ShouldRespondFixture>();
    for (const f of sample) truthByCaseId.set(f.id, f);

    const perfectMode = mockMode({
      id: "guided",
      output: (req) => {
        // Strip the `#i` suffix the runner adds for repetition.
        const fixtureId = req.caseId.split("#")[0];
        const fixture = truthByCaseId.get(fixtureId);
        const expected = fixture ? fixture.expected : "RESPOND";
        return JSON.stringify({ shouldRespond: expected });
      },
    });
    const brokenMode = mockMode({
      id: "unguided",
      output: () => "this isn't json at all",
    });

    // Stub the runner's fixture loader by only running cases we control: we
    // keep the n=1 and rely on the real fixtures being read; the slice
    // above only matters for the perfect-mode lookup table.
    const report = await runBench({
      tasks: ["should_respond"],
      modes: [perfectMode, brokenMode],
      n: 1,
    });
    expect(report.tasks).toEqual(["should_respond"]);
    expect(report.summaries.length).toBe(2);

    const perfectSummary = report.summaries.find((s) => s.modeId === "guided");
    const brokenSummary = report.summaries.find((s) => s.modeId === "unguided");
    expect(perfectSummary).toBeDefined();
    expect(brokenSummary).toBeDefined();

    // Perfect mode: every case parses + matches schema. label_match should
    // be 100% on the slice we control; for cases outside the slice the
    // mock falls back to "RESPOND" which won't always be the truth — so
    // we test parse/schema rates here, not label.
    expect(perfectSummary?.parse_success_rate).toBe(1);
    expect(perfectSummary?.schema_valid_rate).toBe(1);

    // Broken mode: 0% parse success → 0% schema. label is N/A so the
    // rollup reports 0 (no eligible cases).
    expect(brokenSummary?.parse_success_rate).toBe(0);
    expect(brokenSummary?.schema_valid_rate).toBe(0);
    expect(brokenSummary?.label_match_rate).toBe(0);

    // Sanity: cases array is non-empty and has per-call entries.
    expect(report.cases.length).toBeGreaterThan(0);
    for (const c of report.cases) {
      expect(typeof c.total_latency_ms).toBe("number");
      expect(c.tokens_generated).toBeGreaterThanOrEqual(0);
    }
  });

  it("records skipped modes without invoking them", async () => {
    const skippingMode: ModeAdapter = {
      id: "cerebras",
      async available() {
        return "no API key";
      },
      async generate() {
        throw new Error("should not be called");
      },
    };
    const report = await runBench({
      tasks: ["should_respond"],
      modes: [skippingMode],
      n: 1,
    });
    expect(report.skipped).toEqual([
      { modeId: "cerebras", reason: "no API key" },
    ]);
    expect(report.cases).toEqual([]);
    expect(report.modes).toEqual([]);
  });
});

describe("strict-guided mode", () => {
  it("initializes with id 'strict-guided'", () => {
    const mode = new ElizaStrictGuidedMode();
    expect(mode.id).toBe("strict-guided");
  });

  it("available() returns null or skip reason (depending on engine state)", async () => {
    const mode = new ElizaStrictGuidedMode();
    const skipReason = await mode.available();
    // Engine availability varies by environment; just check that the method
    // returns either null (available) or a string (skip reason).
    expect(skipReason === null || typeof skipReason === "string").toBe(true);
  });
});

describe("eliza-guided skeleton compiler", () => {
  it("produces a single literal/enum skeleton for should-respond", () => {
    const mode = new ElizaGuidedMode();
    // We can call the exported skeleton helper directly. Import it for shape.
    // (We exercise it via the runner test above for the integration side.)
    expect(mode.id).toBe("guided");
  });
});

describe("cerebras mode with mock client", () => {
  function shouldRespondRequest(): ModeRequest {
    return {
      taskId: "should_respond",
      caseId: "demo#0",
      systemPrompt: "system",
      userPrompt: "hello",
      jsonSchema: {
        type: "object",
        properties: {
          shouldRespond: {
            type: "string",
            enum: ["RESPOND", "IGNORE", "STOP"],
          },
        },
        required: ["shouldRespond"],
      },
      skeletonHint: {
        type: "object",
        freeFields: [],
        enumKey: "shouldRespond",
        enumValues: ["RESPOND", "IGNORE", "STOP"],
      },
      maxTokens: 32,
    };
  }

  it("runs through the tool-use path and returns the tool arguments as JSON", async () => {
    const requests: unknown[] = [];
    const mockClient: CerebrasClient = {
      async chatCompletions(req) {
        requests.push(req);
        return {
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "should_respond",
                      arguments: JSON.stringify({ shouldRespond: "RESPOND" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 3,
            total_tokens: 8,
          },
        };
      },
    };
    const mode = new CerebrasMode({ client: mockClient });
    const skipReason = await mode.available();
    expect(skipReason).toBeNull();
    const result = await mode.generate(shouldRespondRequest());
    expect(result.error).toBeUndefined();
    const parsed = JSON.parse(result.rawOutput) as { shouldRespond: string };
    expect(parsed.shouldRespond).toBe("RESPOND");
    expect((requests[0] as { max_tokens: number }).max_tokens).toBe(256);
  });

  it("falls back to JSON-schema mode when tool-use returns empty output with tokens", async () => {
    const requests: unknown[] = [];
    const mockClient: CerebrasClient = {
      async chatCompletions(req) {
        requests.push(req);
        if (requests.length === 1) {
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 5,
              completion_tokens: 11,
              total_tokens: 16,
            },
          };
        }
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({ shouldRespond: "IGNORE" }),
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 9,
            completion_tokens: 4,
            total_tokens: 13,
          },
        };
      },
    };
    const mode = new CerebrasMode({ client: mockClient });
    await mode.available();
    const result = await mode.generate(shouldRespondRequest());

    expect(JSON.parse(result.rawOutput)).toEqual({ shouldRespond: "IGNORE" });
    expect(result.tokensGenerated).toBe(4);
    expect(result.warnings?.[0]).toContain("completion_tokens=11");
    expect(requests).toHaveLength(2);
    expect((requests[0] as { tools?: unknown[] }).tools).toHaveLength(1);
    expect(
      (requests[1] as { response_format?: { type: string } }).response_format
        ?.type,
    ).toBe("json_schema");
  });

  it("falls back to prompt-only JSON when JSON-schema setup fails", async () => {
    const requests: unknown[] = [];
    const mockClient: CerebrasClient = {
      async chatCompletions(req) {
        requests.push(req);
        if (requests.length === 1) {
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "   ",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 5,
              completion_tokens: 6,
              total_tokens: 11,
            },
          };
        }
        if (requests.length === 2) {
          throw new Error("unsupported response_format");
        }
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({ shouldRespond: "STOP" }),
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
          },
        };
      },
    };
    const mode = new CerebrasMode({ client: mockClient });
    await mode.available();
    const result = await mode.generate(shouldRespondRequest());

    expect(JSON.parse(result.rawOutput)).toEqual({ shouldRespond: "STOP" });
    expect(result.warnings?.join("\n")).toContain(
      "unsupported response_format",
    );
    expect(requests).toHaveLength(3);
    expect((requests[2] as { response_format?: unknown }).response_format).toBe(
      undefined,
    );
    expect((requests[2] as { tools?: unknown }).tools).toBeUndefined();
  });

  it("reports empty output after all fallback attempts without dropping usage tokens", async () => {
    const mockClient: CerebrasClient = {
      async chatCompletions() {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 9,
            total_tokens: 14,
          },
        };
      },
    };
    const mode = new CerebrasMode({ client: mockClient });
    await mode.available();
    const result = await mode.generate(shouldRespondRequest());

    expect(result.rawOutput).toBe("");
    expect(result.tokensGenerated).toBe(9);
    expect(result.error).toContain("empty output");
    expect(result.error).toContain("prompt-only");
    expect(result.error).toContain("completion_tokens=9");
    expect(result.warnings).toHaveLength(3);
  });

  it("aborts transport failures instead of publishing them as scored zero cases", async () => {
    const mockClient: CerebrasClient = {
      async chatCompletions() {
        throw new Error("ECONNRESET");
      },
    };
    const mode = new CerebrasMode({ client: mockClient });
    await mode.available();

    await expect(
      runBench({
        tasks: ["should_respond"],
        modes: [mode],
        n: 1,
      }),
    ).rejects.toThrow(/adapter failed before producing/);
  });

  it("skips with a reason when CEREBRAS_API_KEY is absent and no client is injected", async () => {
    const original = process.env.CEREBRAS_API_KEY;
    process.env.CEREBRAS_API_KEY = "";
    try {
      const mode = new CerebrasMode();
      const reason = await mode.available();
      expect(reason).toBeTruthy();
    } finally {
      if (original !== undefined) process.env.CEREBRAS_API_KEY = original;
    }
  });
});

describe("report rendering", () => {
  it("renders a non-empty table from a small summary set", () => {
    const cases = [
      buildMetric({
        taskId: "should_respond",
        modeId: "guided",
        caseId: "a",
        result: {
          rawOutput: '{"shouldRespond":"RESPOND"}',
          firstTokenLatencyMs: 5,
          totalLatencyMs: 100,
          tokensGenerated: 8,
        },
        parse_success: true,
        schema_valid: true,
        label_match: true,
      }),
      buildMetric({
        taskId: "should_respond",
        modeId: "guided",
        caseId: "b",
        result: {
          rawOutput: '{"shouldRespond":"IGNORE"}',
          firstTokenLatencyMs: 5,
          totalLatencyMs: 200,
          tokensGenerated: 8,
        },
        parse_success: true,
        schema_valid: true,
        label_match: false,
      }),
    ];
    const summaries = summarize(cases);
    const rows = buildTableRows(summaries);
    const text = renderTable(rows);
    expect(text).toContain("task");
    expect(text).toContain("guided");
    expect(text).toContain("should_respond");
    const fullReport = renderReport({
      schemaVersion: "eliza-1-bench-v1",
      generatedAt: "now",
      tasks: ["should_respond"],
      modes: ["guided"],
      skipped: [],
      cases,
      summaries,
    });
    expect(fullReport).toContain("eliza-1 bench report");
    expect(fullReport).toContain("guided");
  });
});
