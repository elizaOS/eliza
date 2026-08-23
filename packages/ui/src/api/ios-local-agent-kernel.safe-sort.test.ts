/**
 * Regression coverage for newest-first transcript and memory-feed ordering
 * in the iOS local agent kernel.
 *
 * Both sorts drive user-visible recency (transcript list and memory feed).
 * A non-finite createdAt previously returned NaN and left the list in
 * insertion order instead of newest-first.
 */
import { describe, expect, it } from "vitest";
import {
  __testCompareFeedItemByCreatedAtDesc as cmpFeed,
  __testCompareTranscriptByCreatedAtDesc as cmpTranscript,
} from "./ios-local-agent-kernel.ts";

function item(id: string, createdAt: number) {
  return { id, createdAt } as { id: string; createdAt: number };
}

describe("ios-local-agent-kernel createdAt ordering", () => {
  it("sorts transcripts newest-first", () => {
    expect([...[item("a", 10), item("c", 30), item("b", 20)].sort(cmpTranscript).map((i) => i.id)]).toEqual(["c", "b", "a"]);
  });
  it("sorts memory feed newest-first", () => {
    expect([...[item("a", 10), item("c", 30), item("b", 20)].sort(cmpFeed).map((i) => i.id)]).toEqual(["c", "b", "a"]);
  });
  it("treats NaN/Infinity as 0 oldest", () => {
    expect([...[item("c", 30), item("b", Number.NaN), item("a", 10)].sort(cmpTranscript).map((i) => i.id)]).toEqual(["c", "a", "b"]);
    expect([...[item("c", 30), item("b", Number.NaN), item("a", 10)].sort(cmpFeed).map((i) => i.id)]).toEqual(["c", "a", "b"]);
  });
  it("breaks ties by descending id", () => {
    expect([...[item("a", 10), item("b", 10)].sort(cmpTranscript).map((i) => i.id)]).toEqual(["b", "a"]);
    expect([...[item("a", 10), item("b", 10)].sort(cmpFeed).map((i) => i.id)]).toEqual(["b", "a"]);
  });
});
