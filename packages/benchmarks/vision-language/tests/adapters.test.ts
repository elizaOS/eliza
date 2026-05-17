import { describe, expect, it } from "vitest";
import { ChartQaAdapter } from "../src/adapters/chartqa_adapter.ts";
import { DocVqaAdapter } from "../src/adapters/docvqa_adapter.ts";
import {
  OSWorldAdapter,
  parseActionList,
} from "../src/adapters/osworld_adapter.ts";
import {
  parseClickFromText,
  ScreenSpotAdapter,
} from "../src/adapters/screenspot_adapter.ts";
import { TextVqaAdapter } from "../src/adapters/textvqa_adapter.ts";

describe("TextVqaAdapter", () => {
  it("loads 5 smoke samples with the expected shape", async () => {
    const adapter = new TextVqaAdapter();
    const samples = await adapter.loadSamples(5, { smoke: true });
    expect(samples).toHaveLength(5);
    for (const s of samples) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.question).toBe("string");
      expect(Array.isArray(s.payload.answers)).toBe(true);
      expect(s.payload.answers.length).toBeGreaterThan(0);
    }
  });
  it("scores on free text predictions", async () => {
    const adapter = new TextVqaAdapter();
    const [first] = await adapter.loadSamples(1, { smoke: true });
    const goodPrediction = { text: first.payload.answers[0], latencyMs: 1 };
    const badPrediction = { text: "definitely not", latencyMs: 1 };
    expect(adapter.scoreOne(first, goodPrediction).score).toBeGreaterThan(0);
    expect(adapter.scoreOne(first, badPrediction).score).toBe(0);
  });
});

describe("DocVqaAdapter", () => {
  it("scores ANLS over the smoke fixture", async () => {
    const adapter = new DocVqaAdapter();
    const [first] = await adapter.loadSamples(1, { smoke: true });
    const correct = adapter.scoreOne(first, {
      text: first.payload.answers[0],
      latencyMs: 1,
    });
    expect(correct.score).toBeGreaterThan(0.9);
    const wrong = adapter.scoreOne(first, { text: "xxxxxxxxxx", latencyMs: 1 });
    expect(wrong.score).toBe(0);
  });
});

describe("ChartQaAdapter", () => {
  it("uses relaxed numeric scoring for numeric answers", async () => {
    const adapter = new ChartQaAdapter();
    const samples = await adapter.loadSamples(5, { smoke: true });
    const numericSample = samples.find(
      (s) => s.payload.answerType === "numeric",
    );
    expect(numericSample).toBeDefined();
    if (!numericSample) return;
    const closeEnough = adapter.scoreOne(numericSample, {
      text: String(
        Number(numericSample.payload.answers[0].replace(/[^\d.-]/g, "")) + 0.5,
      ),
      latencyMs: 1,
    });
    expect(closeEnough.score).toBe(1);
  });
});

describe("ScreenSpotAdapter", () => {
  it("scores clicks inside / outside the target bbox", async () => {
    const adapter = new ScreenSpotAdapter();
    const [sample] = await adapter.loadSamples(1, { smoke: true });
    const [x1, y1, x2, y2] = sample.payload.bbox;
    const inside = adapter.scoreOne(sample, {
      click: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
      latencyMs: 1,
    });
    expect(inside.score).toBe(1);
    const outside = adapter.scoreOne(sample, {
      click: { x: x1 - 100, y: y1 - 100 },
      latencyMs: 1,
    });
    expect(outside.score).toBe(0);
    const missing = adapter.scoreOne(sample, { latencyMs: 1 });
    expect(missing.score).toBe(0);
  });
  it("parseClickFromText accepts CSV and JSON forms", () => {
    expect(parseClickFromText("100, 200")).toEqual({ x: 100, y: 200 });
    expect(parseClickFromText("(415, 612)")).toEqual({ x: 415, y: 612 });
    expect(parseClickFromText('{"x": 1, "y": 2}')).toEqual({ x: 1, y: 2 });
    expect(parseClickFromText("nope")).toBeNull();
    expect(parseClickFromText("")).toBeNull();
  });
});

describe("OSWorldAdapter", () => {
  it("scores trace overlap on smoke fixtures", async () => {
    const adapter = new OSWorldAdapter();
    const [sample] = await adapter.loadSamples(1, { smoke: true });
    const exact = adapter.scoreOne(sample, {
      actions: sample.payload.trace,
      latencyMs: 1,
    });
    expect(exact.score).toBe(1);
    const empty = adapter.scoreOne(sample, { actions: [], latencyMs: 1 });
    expect(empty.score).toBe(0);
  });
  it("parseActionList parses well-formed JSON arrays", () => {
    const parsed = parseActionList(
      'sure, here you go: [{"type":"CLICK","x":1,"y":2},{"type":"DONE"}]',
    );
    expect(parsed).toEqual([{ type: "CLICK", x: 1, y: 2 }, { type: "DONE" }]);
  });
  it("parseActionList drops entries with unknown action types", () => {
    const parsed = parseActionList('[{"type":"FLY"},{"type":"DONE"}]');
    expect(parsed).toEqual([{ type: "DONE" }]);
  });
  it("parseActionList returns [] when no array is found", () => {
    expect(parseActionList("nope")).toEqual([]);
    expect(parseActionList("")).toEqual([]);
  });
});
