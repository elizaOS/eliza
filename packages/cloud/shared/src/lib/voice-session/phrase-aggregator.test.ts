/**
 * Coverage for phrase-aggregator.
 */
import { describe, expect, it } from "vitest";
import { PhraseAggregator } from "./phrase-aggregator.js";

describe("phrase-aggregator", () => {
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
