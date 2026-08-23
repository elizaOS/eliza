/**
 * Coverage for phrase-aggregator.
 */
import { describe, expect, it } from "vitest";
import {
  PHRASE_MAX_BUFFER_CHARS,
  PHRASE_MIN_EMIT_CHARS,
  PhraseAggregator,
} from "./phrase-aggregator.js";

describe("phrase-aggregator", () => {
  it("exposes constants", () => {
    expect(PHRASE_MAX_BUFFER_CHARS).toBe(180);
    expect(PHRASE_MIN_EMIT_CHARS).toBe(2);
  });
  it("aggregates phrases", () => {
    const agg = new PhraseAggregator();
    const r1 = agg.push("Hello world. ");
    expect(r1.length).toBeGreaterThan(0);
    expect(r1[0]).toContain("Hello world");
  });
  it("flushes remainder", () => {
    const agg = new PhraseAggregator();
    agg.push("hello");
    const flushed = agg.flush();
    expect(flushed.length).toBeGreaterThan(0);
  });
});
