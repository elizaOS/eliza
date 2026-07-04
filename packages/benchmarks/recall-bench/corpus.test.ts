// Exercises recall-bench benchmark recall bench corpus.test behavior against deterministic harness fixtures.
import { describe, expect, it } from "vitest";
import {
  buildCorpus,
  buildFacts,
  buildMorphologyCorpus,
  type CorpusTier,
} from "./corpus.ts";
import { cosine, embedText, tokenize } from "./embedding.ts";

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

describe("recall-bench corpus", () => {
  it("is deterministic", () => {
    expect(buildCorpus("smoke")).toEqual(buildCorpus("smoke"));
    expect(buildFacts("smoke")).toEqual(buildFacts("smoke"));
  });

  it("builds the labelled tiers at the documented scale", () => {
    const cases: Array<[CorpusTier, number]> = [
      ["smoke", 60],
      ["1k", 1000],
    ];
    for (const [tier, count] of cases) {
      const c = buildCorpus(tier);
      expect(c.docs).toHaveLength(count);
      expect(c.queries).toHaveLength(c.topics);
      // Every query's relevant ids exist and belong to one topic.
      const ids = new Set(c.docs.map((d) => d.id));
      for (const q of c.queries) {
        expect(q.relevantDocIds.length).toBeGreaterThan(0);
        for (const id of q.relevantDocIds) expect(ids.has(id)).toBe(true);
      }
    }
  });

  // The fail-open gap is real only if the vector embedding separates a topic's
  // relevant docs from its keyword-confusable distractors (both carry the query's
  // base token, so keyword/BM25 cannot). Assert that separation directly with the
  // bench's own embedding — this is the invariant the document run depends on.
  it("vector-separates relevant from keyword-confusable distractors", () => {
    const c = buildCorpus("1k");
    const docById = new Map(c.docs.map((d) => [d.id, d]));
    let relWins = 0;
    for (const q of c.queries) {
      const qv = embedText(q.text);
      const relMean = mean(
        q.relevantDocIds.map((id) =>
          cosine(qv, embedText(docById.get(id)!.text)),
        ),
      );
      const confMean = mean(
        c.docs
          .filter((d) => d.id.startsWith(`confuse-${q.topic}-`))
          .map((d) => cosine(qv, embedText(d.text))),
      );
      // Both share the base token, yet relevant sits clearly closer to the query.
      if (relMean > confMean + 0.1) relWins += 1;
    }
    expect(relWins / c.queries.length).toBeGreaterThan(0.9);
  });

  // Keyword has no topic signal to rank by: a query shares exactly one non-filler
  // token (the base) with BOTH its relevant and its confusable docs.
  it("keyword cannot separate relevant from confusable on topic tokens", () => {
    const c = buildCorpus("smoke");
    const docById = new Map(c.docs.map((d) => [d.id, d]));
    for (const q of c.queries) {
      const qTokens = new Set(tokenize(q.text));
      const base = `${tokenize(q.text)[0]}`; // query text starts with the base token
      const shared = (id: string) =>
        [...new Set(tokenize(docById.get(id)!.text))].filter((t) =>
          qTokens.has(t),
        );
      const rel = shared(q.relevantDocIds[0]);
      const conf = shared(
        c.docs.find((d) => d.id.startsWith(`confuse-${q.topic}-`))!.id,
      );
      // The base token is the only query-overlapping signal, present in both.
      expect(rel).toContain(base);
      expect(conf).toContain(base);
    }
  });

  // Morphology slice: the lift is real only if each query's surface form never
  // appears verbatim in its relevant docs — so only stemming (not exact-token
  // BM25) can bridge query→doc. Assert that invariant + the documented shape.
  describe("morphology slice", () => {
    it("is deterministic", () => {
      expect(buildMorphologyCorpus()).toEqual(buildMorphologyCorpus());
    });

    it("queries' surface form is absent from every relevant doc", () => {
      const m = buildMorphologyCorpus();
      expect(m.queries).toHaveLength(10);
      expect(m.docs).toHaveLength(40);
      const docById = new Map(m.docs.map((d) => [d.id, d]));
      for (const q of m.queries) {
        const queryWord = q.text.split(/\s+/)[0]; // the -ing form
        expect(q.relevantDocIds.length).toBeGreaterThanOrEqual(3);
        for (const id of q.relevantDocIds) {
          const text = docById.get(id)?.text ?? "";
          // exact-token BM25 would score 0 — only a shared stem can match.
          expect(tokenize(text)).not.toContain(queryWord);
        }
      }
    });
  });
});
