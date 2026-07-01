import { describe, expect, it } from "vitest";
import {
  chunkText,
  joinWordPieces,
  normalizeGroupedWord,
  type RawNerGroup,
  relocateEntities,
  stitchBioTokens,
} from "./ner-recognizer.js";

describe("normalizeGroupedWord", () => {
  it("strips ## subword joins", () => {
    expect(normalizeGroupedWord("New ##ark")).toBe("Newark");
    expect(normalizeGroupedWord("North ##wind")).toBe("Northwind");
  });

  it("trims leading/trailing whitespace and collapses runs", () => {
    expect(normalizeGroupedWord("  Dana   Whitfield ")).toBe("Dana Whitfield");
  });

  it("leaves clean words untouched", () => {
    expect(normalizeGroupedWord("Fairhaven")).toBe("Fairhaven");
  });
});

describe("joinWordPieces", () => {
  it("joins ## continuations with no space and others with a space", () => {
    expect(joinWordPieces(["North", "##wind", "Labs"])).toBe("Northwind Labs");
    expect(joinWordPieces(["Fair", "##haven"])).toBe("Fairhaven");
    expect(joinWordPieces(["Dana", "W", "##hit", "##field"])).toBe(
      "Dana Whitfield",
    );
  });
});

describe("stitchBioTokens", () => {
  it("stitches per-token BIO into whole entities (the real v3 pipeline shape)", () => {
    // Verbatim per-token output captured from dslim/distilbert-NER via
    // transformers.js v3 (which returns per-token BIO, not merged entities, for
    // BERT tokenizers — hence we stitch ourselves).
    const tokens: RawNerGroup[] = [
      { entity: "B-PER", word: "Em", score: 0.91, start: null, end: null },
      { entity: "B-PER", word: "##ail", score: 0.96, start: null, end: null },
      { entity: "I-PER", word: "Dana", score: 0.9, start: null, end: null },
      { entity: "I-PER", word: "W", score: 0.96, start: null, end: null },
      { entity: "I-PER", word: "##hit", score: 0.93, start: null, end: null },
      { entity: "I-PER", word: "##field", score: 0.96, start: null, end: null },
      { entity: "B-ORG", word: "North", score: 0.95, start: null, end: null },
      { entity: "B-ORG", word: "##wind", score: 0.96, start: null, end: null },
      { entity: "I-ORG", word: "Labs", score: 0.89, start: null, end: null },
      { entity: "B-LOC", word: "Fair", score: 0.98, start: null, end: null },
      { entity: "B-LOC", word: "##haven", score: 0.95, start: null, end: null },
    ];
    const runs = stitchBioTokens(tokens);
    // One PER run (the model runs "Email…Whitfield" together), one ORG, one LOC.
    expect(runs.map((r) => r.kind)).toEqual(["person", "org", "location"]);
    expect(joinWordPieces(runs[0].pieces)).toBe("Email Dana Whitfield");
    expect(joinWordPieces(runs[1].pieces)).toBe("Northwind Labs");
    expect(joinWordPieces(runs[2].pieces)).toBe("Fairhaven");
  });

  it("closes a run on an O token and opens a fresh one on the next B-*", () => {
    const tokens: RawNerGroup[] = [
      { entity: "B-PER", word: "Sam", score: 0.99, start: null, end: null },
      { entity: "O", word: "went", score: 0.99, start: null, end: null },
      { entity: "B-PER", word: "Kim", score: 0.99, start: null, end: null },
    ];
    const runs = stitchBioTokens(tokens);
    expect(runs).toHaveLength(2);
    expect(joinWordPieces(runs[0].pieces)).toBe("Sam");
    expect(joinWordPieces(runs[1].pieces)).toBe("Kim");
  });

  it("splits when the base label changes even without an O between", () => {
    const tokens: RawNerGroup[] = [
      { entity: "B-PER", word: "Sam", score: 0.99, start: null, end: null },
      { entity: "B-ORG", word: "Acme", score: 0.99, start: null, end: null },
    ];
    const runs = stitchBioTokens(tokens);
    expect(runs.map((r) => r.kind)).toEqual(["person", "org"]);
  });
});

describe("relocateEntities — per-token BIO input (real v3 shape)", () => {
  it("stitches + relocates the real per-token output to exact source spans", () => {
    const text = "Email Dana Whitfield at Northwind Labs in Fairhaven.";
    const tokens: RawNerGroup[] = [
      { entity: "B-PER", word: "Em", score: 0.91, start: null, end: null },
      { entity: "B-PER", word: "##ail", score: 0.96, start: null, end: null },
      { entity: "I-PER", word: "Dana", score: 0.9, start: null, end: null },
      { entity: "I-PER", word: "W", score: 0.96, start: null, end: null },
      { entity: "I-PER", word: "##hit", score: 0.93, start: null, end: null },
      { entity: "I-PER", word: "##field", score: 0.96, start: null, end: null },
      { entity: "B-ORG", word: "North", score: 0.95, start: null, end: null },
      { entity: "B-ORG", word: "##wind", score: 0.96, start: null, end: null },
      { entity: "I-ORG", word: "Labs", score: 0.89, start: null, end: null },
      { entity: "B-LOC", word: "Fair", score: 0.98, start: null, end: null },
      { entity: "B-LOC", word: "##haven", score: 0.95, start: null, end: null },
    ];
    const spans = relocateEntities(text, tokens);
    expect(spans.map((s) => s.kind)).toEqual(["person", "org", "location"]);
    // Every emitted value is an EXACT slice of the source text.
    for (const span of spans) {
      expect(text.slice(span.start, span.end)).toBe(span.value);
    }
    expect(spans[0].value).toBe("Dana Whitfield");
    expect(spans[1].value).toBe("Northwind Labs");
    expect(spans[2].value).toBe("Fairhaven");
  });

  it("preserves a leading command verb when a person span absorbs it", () => {
    const text = "Email Dana Whitfield at Northwind Labs.";
    const tokens: RawNerGroup[] = [
      { entity: "B-PER", word: "Em", score: 0.91, start: null, end: null },
      { entity: "B-PER", word: "##ail", score: 0.96, start: null, end: null },
      { entity: "I-PER", word: "Dana", score: 0.9, start: null, end: null },
      {
        entity: "I-PER",
        word: "Whitfield",
        score: 0.96,
        start: null,
        end: null,
      },
    ];
    const spans = relocateEntities(text, tokens);
    expect(spans).toHaveLength(1);
    expect(spans[0].value).toBe("Dana Whitfield");
    expect(text.slice(spans[0].start, spans[0].end)).toBe("Dana Whitfield");
  });
});

describe("relocateEntities", () => {
  it("re-derives offsets when the pipeline returns null start/end (#359)", () => {
    const text = "Email Dana Whitfield at Northwind Labs in Fairhaven.";
    const groups: RawNerGroup[] = [
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
    ];

    const spans = relocateEntities(text, groups);
    expect(spans).toHaveLength(3);

    const [person, org, loc] = spans;
    // Exact source substrings, not the pipeline's `word`.
    expect(person).toMatchObject({ kind: "person", value: "Dana Whitfield" });
    expect(text.slice(person.start, person.end)).toBe("Dana Whitfield");
    expect(org).toMatchObject({ kind: "org", value: "Northwind Labs" });
    expect(text.slice(org.start, org.end)).toBe("Northwind Labs");
    expect(loc).toMatchObject({ kind: "location", value: "Fairhaven" });
    expect(text.slice(loc.start, loc.end)).toBe("Fairhaven");
  });

  it("locates a ## subword-joined word against the source text", () => {
    const text = "She flew into Newark last night.";
    const groups: RawNerGroup[] = [
      {
        entity_group: "LOC",
        word: "New ##ark",
        score: 0.9,
        start: null,
        end: null,
      },
    ];
    const spans = relocateEntities(text, groups);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ kind: "location", value: "Newark" });
    expect(text.slice(spans[0].start, spans[0].end)).toBe("Newark");
  });

  it("maps repeated entities to successive occurrences via the forward cursor", () => {
    const text = "Dana called. Then Dana left.";
    const groups: RawNerGroup[] = [
      {
        entity_group: "PER",
        word: "Dana",
        score: 0.98,
        start: null,
        end: null,
      },
      {
        entity_group: "PER",
        word: "Dana",
        score: 0.98,
        start: null,
        end: null,
      },
    ];
    const spans = relocateEntities(text, groups);
    expect(spans).toHaveLength(2);
    expect(spans[0].start).toBe(0);
    expect(spans[1].start).toBe(text.indexOf("Dana", 1));
    expect(spans[0].start).not.toBe(spans[1].start);
  });

  it("handles a multi-word ORG with internal whitespace differences", () => {
    const text = "Contract with  Acme   Global   Holdings, Inc. is signed.";
    const groups: RawNerGroup[] = [
      // Grouped word has single spaces; source has irregular whitespace.
      {
        entity_group: "ORG",
        word: "Acme Global Holdings",
        score: 0.92,
        start: null,
        end: null,
      },
    ];
    const spans = relocateEntities(text, groups);
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe("org");
    // Value is the exact source slice, preserving the real (irregular) spacing.
    expect(text.slice(spans[0].start, spans[0].end)).toBe(spans[0].value);
    expect(spans[0].value.replace(/\s+/g, " ")).toBe("Acme Global Holdings");
  });

  it("drops MISC and O labels (too noisy for PII)", () => {
    const text = "The Nobel Prize went to someone.";
    const groups: RawNerGroup[] = [
      {
        entity_group: "MISC",
        word: "Nobel Prize",
        score: 0.99,
        start: null,
        end: null,
      },
      {
        entity_group: "O",
        word: "someone",
        score: 0.99,
        start: null,
        end: null,
      },
    ];
    expect(relocateEntities(text, groups)).toHaveLength(0);
  });

  it("drops spans below the score threshold", () => {
    const text = "Maybe Sam did it.";
    const groups: RawNerGroup[] = [
      { entity_group: "PER", word: "Sam", score: 0.3, start: null, end: null },
    ];
    expect(
      relocateEntities(text, groups, { scoreThreshold: 0.5 }),
    ).toHaveLength(0);
    expect(
      relocateEntities(text, groups, { scoreThreshold: 0.2 }),
    ).toHaveLength(1);
  });

  it("drops a group whose word cannot be located rather than guessing", () => {
    const text = "Hello world.";
    const groups: RawNerGroup[] = [
      {
        entity_group: "PER",
        word: "Zebediah",
        score: 0.99,
        start: null,
        end: null,
      },
    ];
    expect(relocateEntities(text, groups)).toHaveLength(0);
  });

  it("prefers pipeline offsets when present but still slices the source", () => {
    const text = "Ping Alice now.";
    const groups: RawNerGroup[] = [
      { entity_group: "PER", word: "Alice", score: 0.99, start: 5, end: 10 },
    ];
    const spans = relocateEntities(text, groups);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("Alice");
  });

  it("trims stray leading space in a grouped word before locating", () => {
    const text = "Meet Bob here.";
    const groups: RawNerGroup[] = [
      {
        entity_group: "PER",
        word: " Bob",
        score: 0.99,
        start: null,
        end: null,
      },
    ];
    const spans = relocateEntities(text, groups);
    expect(spans).toHaveLength(1);
    expect(spans[0].value).toBe("Bob");
    expect(text.slice(spans[0].start, spans[0].end)).toBe("Bob");
  });

  it("uses the `entity` field when `entity_group` is absent", () => {
    const text = "Call Priya.";
    const groups: RawNerGroup[] = [
      { entity: "B-PER", word: "Priya", score: 0.99, start: null, end: null },
    ];
    const spans = relocateEntities(text, groups);
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe("person");
  });

  it("returns [] for empty text", () => {
    expect(relocateEntities("", [])).toHaveLength(0);
  });
});

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    const chunks = chunkText("short text");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ text: "short text", offset: 0 });
  });

  it("splits long text into overlapping windows and preserves offsets", () => {
    const text = `${"a ".repeat(1000)}Dana ${"b ".repeat(1000)}`;
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk's slice must equal the source at its recorded offset.
    for (const chunk of chunks) {
      expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(
        chunk.text,
      );
    }
    // The whole text is covered (last chunk reaches the end).
    const last = chunks[chunks.length - 1];
    expect(last.offset + last.text.length).toBe(text.length);
  });
});
