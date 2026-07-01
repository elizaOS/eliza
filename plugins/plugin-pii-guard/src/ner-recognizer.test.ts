import { describe, expect, it, vi } from "vitest";
import {
  type ClassifierFactory,
  NerEntityRecognizer,
  type RawNerGroup,
  type TokenClassifier,
} from "./ner-recognizer.js";

/** Build a fake pipeline that returns canned results keyed by chunk text match. */
function fakeClassifier(
  respond: (text: string) => RawNerGroup[],
): TokenClassifier {
  return (text) => Promise.resolve(respond(text));
}

describe("NerEntityRecognizer (injected fake pipeline — no download)", () => {
  it("recognizes person / org / location end-to-end", async () => {
    const text = "Email Dana Whitfield at Northwind Labs in Fairhaven.";
    const factory: ClassifierFactory = () =>
      Promise.resolve(
        fakeClassifier(() => [
          {
            entity_group: "PER",
            word: "Dana Whitfield",
            score: 0.99,
            start: null,
            end: null,
          },
          {
            entity_group: "ORG",
            word: "Northwind Labs",
            score: 0.97,
            start: null,
            end: null,
          },
          {
            entity_group: "LOC",
            word: "Fairhaven",
            score: 0.95,
            start: null,
            end: null,
          },
          {
            entity_group: "MISC",
            word: "Some Award",
            score: 0.99,
            start: null,
            end: null,
          },
        ]),
      );

    const rec = new NerEntityRecognizer({ classifierFactory: factory });
    const spans = await rec.recognize(text);

    expect(rec.name).toBe("distilbert-ner");
    expect(spans.map((s) => s.kind)).toEqual(["person", "org", "location"]);
    for (const span of spans) {
      expect(text.slice(span.start, span.end)).toBe(span.value);
    }
  });

  it("stitches per-token BIO output (the real transformers.js v3 shape)", async () => {
    const text = "Email Dana Whitfield at Northwind Labs in Fairhaven.";
    // Verbatim per-token output captured from the real model run.
    const factory: ClassifierFactory = () =>
      Promise.resolve(
        fakeClassifier(() => [
          { entity: "B-PER", word: "Em", score: 0.91, start: null, end: null },
          {
            entity: "B-PER",
            word: "##ail",
            score: 0.96,
            start: null,
            end: null,
          },
          { entity: "I-PER", word: "Dana", score: 0.9, start: null, end: null },
          { entity: "I-PER", word: "W", score: 0.96, start: null, end: null },
          {
            entity: "I-PER",
            word: "##hit",
            score: 0.93,
            start: null,
            end: null,
          },
          {
            entity: "I-PER",
            word: "##field",
            score: 0.96,
            start: null,
            end: null,
          },
          {
            entity: "B-ORG",
            word: "North",
            score: 0.95,
            start: null,
            end: null,
          },
          {
            entity: "B-ORG",
            word: "##wind",
            score: 0.96,
            start: null,
            end: null,
          },
          {
            entity: "I-ORG",
            word: "Labs",
            score: 0.89,
            start: null,
            end: null,
          },
          {
            entity: "B-LOC",
            word: "Fair",
            score: 0.98,
            start: null,
            end: null,
          },
          {
            entity: "B-LOC",
            word: "##haven",
            score: 0.95,
            start: null,
            end: null,
          },
        ]),
      );
    const rec = new NerEntityRecognizer({ classifierFactory: factory });
    const spans = await rec.recognize(text);
    expect(spans.map((s) => s.kind)).toEqual(["person", "org", "location"]);
    expect(spans.map((s) => s.value)).toEqual([
      "Email Dana Whitfield",
      "Northwind Labs",
      "Fairhaven",
    ]);
    for (const span of spans) {
      expect(text.slice(span.start, span.end)).toBe(span.value);
    }
  });

  it("returns [] for empty input without loading the model", async () => {
    const factory = vi.fn<ClassifierFactory>();
    const rec = new NerEntityRecognizer({ classifierFactory: factory });
    expect(await rec.recognize("")).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
  });

  it("loads the model exactly once across concurrent recognize() calls", async () => {
    const factory = vi.fn<ClassifierFactory>(() =>
      Promise.resolve(fakeClassifier(() => [])),
    );
    const rec = new NerEntityRecognizer({ classifierFactory: factory });

    await Promise.all([
      rec.recognize("a bit of text"),
      rec.recognize("some more text"),
      rec.recognize("and yet more"),
    ]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(rec.isReady()).toBe(true);
    expect(rec.hasFailed()).toBe(false);
  });

  it("degrades to [] (never throws) when the model load fails", async () => {
    const factory: ClassifierFactory = () =>
      Promise.reject(new Error("offline: cannot download model"));
    const rec = new NerEntityRecognizer({ classifierFactory: factory });

    const spans = await rec.recognize("Ping Dana Whitfield.");
    expect(spans).toEqual([]);
    expect(rec.hasFailed()).toBe(true);
    expect(rec.isReady()).toBe(false);
  });

  it("honors a custom score threshold", async () => {
    const factory: ClassifierFactory = () =>
      Promise.resolve(
        fakeClassifier(() => [
          {
            entity_group: "PER",
            word: "Sam",
            score: 0.4,
            start: null,
            end: null,
          },
        ]),
      );
    const strict = new NerEntityRecognizer({
      classifierFactory: factory,
      scoreThreshold: 0.5,
    });
    const lenient = new NerEntityRecognizer({
      classifierFactory: factory,
      scoreThreshold: 0.3,
    });
    expect(await strict.recognize("Ask Sam.")).toHaveLength(0);
    expect(await lenient.recognize("Ask Sam.")).toHaveLength(1);
  });

  it("chunks long input and re-bases offsets onto the full source text", async () => {
    // "Dana" appears once, far past the first ~1600-char window boundary, so it
    // is found in a later chunk; its offset must be the position in the FULL text.
    const prefix = "filler word ".repeat(200); // ~2400 chars
    const text = `${prefix}Contact Dana today.`;
    const danaAbsolute = text.indexOf("Dana");

    const factory: ClassifierFactory = () =>
      Promise.resolve(
        fakeClassifier((chunk) =>
          chunk.includes("Dana")
            ? [
                {
                  entity_group: "PER",
                  word: "Dana",
                  score: 0.99,
                  start: null,
                  end: null,
                },
              ]
            : [],
        ),
      );

    const rec = new NerEntityRecognizer({ classifierFactory: factory });
    const spans = await rec.recognize(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].start).toBe(danaAbsolute);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("Dana");
  });
});
