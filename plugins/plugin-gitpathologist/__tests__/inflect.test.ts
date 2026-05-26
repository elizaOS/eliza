import { describe, expect, it } from "vitest";
import { findInflections } from "../src/pipeline/inflect.ts";
import type { CommitHealthPoint } from "../src/types.ts";

function point(score: number, delta: number, sha = `${score}`): CommitHealthPoint {
  return {
    sha: sha.padEnd(40, "0"),
    parents: [],
    author: "alice",
    authorEmail: "alice@example.com",
    date: "2026-04-01T10:00:00Z",
    subject: "x",
    body: "",
    files: [],
    diffSnippet: "",
    type: "other",
    riskFlags: [],
    classifiedBy: "rule",
    delta,
    score,
    churn: 0,
  };
}

describe("findInflections.peaks", () => {
  it("finds a single peak in an ascending-then-descending series", () => {
    const points = [
      point(0.05, 0.05, "a"),
      point(0.15, 0.10, "b"),
      point(0.40, 0.25, "c"), // peak
      point(0.25, -0.15, "d"),
      point(0.10, -0.15, "e"),
      point(0.05, -0.05, "f"),
    ];
    const { peaks } = findInflections(points);
    expect(peaks.length).toBeGreaterThanOrEqual(1);
    expect(peaks[0]?.sha.startsWith("c")).toBe(true);
  });

  it("ignores peaks below the minimum threshold", () => {
    const points = [
      point(0.0, 0),
      point(0.02, 0.02),
      point(0.01, -0.01),
    ];
    const { peaks } = findInflections(points);
    expect(peaks.length).toBe(0);
  });
});

describe("findInflections.drifts", () => {
  it("finds a drift onset when the score drops sustainedly after a point", () => {
    const points = [
      point(0.20, 0.05, "a"),
      point(0.30, 0.10, "b"),
      point(0.50, 0.20, "c"), // drift onset
      point(0.20, -0.30, "d"),
      point(0.05, -0.15, "e"),
      point(-0.05, -0.10, "f"),
      point(-0.10, -0.05, "g"),
      point(-0.10, 0.0, "h"),
    ];
    const { drifts } = findInflections(points);
    expect(drifts.length).toBeGreaterThanOrEqual(1);
    expect(drifts.some((d) => d.sha.startsWith("c"))).toBe(true);
  });

  it("returns no drifts on flat history", () => {
    const points = Array.from({ length: 8 }, (_, i) => point(0.05, 0.0, `${i}`));
    const { drifts } = findInflections(points);
    expect(drifts.length).toBe(0);
  });
});
