import { describe, expect, test } from "bun:test";
import { searchNodes } from "../../../workflow/utils/catalog";

describe("searchNodes", () => {
  test("returns empty array for empty keywords", () => {
    const results = searchNodes([]);
    expect(results).toEqual([]);
  });

  test("finds Gmail node by exact keyword", () => {
    const results = searchNodes(["gmail"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].node.name.toLowerCase()).toContain("gmail");
    expect(results[0].score).toBeGreaterThanOrEqual(5);
  });

  test("finds Slack node by keyword", () => {
    const results = searchNodes(["slack"]);
    expect(results.length).toBeGreaterThan(0);
    const slackNode = results.find((r) => r.node.name.toLowerCase().includes("slack"));
    expect(slackNode).not.toBeUndefined();
    expect(slackNode?.score).toBeGreaterThanOrEqual(5);
  });

  test("finds nodes by multiple keywords", () => {
    const results = searchNodes(["gmail", "send", "email"]);
    expect(results.length).toBeGreaterThan(0);
    // Gmail should score high with multiple keyword matches
    const gmailResult = results.find((r) => r.node.name.toLowerCase().includes("gmail"));
    expect(gmailResult).toBeDefined();
    expect(gmailResult?.score).toBeGreaterThanOrEqual(5);
  });

  test("respects limit parameter", () => {
    const results = searchNodes(["send"], 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("returns results sorted by score descending", () => {
    const results = searchNodes(["http", "request"]);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  test("filters out zero-score nodes", () => {
    const results = searchNodes(["xyznonexistentnode"]);
    expect(results.length).toBe(0);
  });

  test("handles case insensitivity", () => {
    const lower = searchNodes(["gmail"]);
    const upper = searchNodes(["GMAIL"]);
    const mixed = searchNodes(["Gmail"]);
    // All should find the same nodes
    expect(lower.length).toBe(upper.length);
    expect(lower.length).toBe(mixed.length);
  });

  test("finds trigger nodes", () => {
    const results = searchNodes(["schedule", "trigger"]);
    expect(results.length).toBeGreaterThan(0);
    const triggerNode = results.find(
      (r) =>
        r.node.name.toLowerCase().includes("schedule") ||
        r.node.name.toLowerCase().includes("trigger")
    );
    expect(triggerNode).toBeDefined();
  });

  test("includes match reason for scored nodes", () => {
    const results = searchNodes(["webhook"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchReason).not.toBe("no strong match");
  });

  test("scores exact name match higher than partial", () => {
    // Search for a term that has both exact and partial matches
    const results = searchNodes(["http"]);
    if (results.length >= 2) {
      // Node with exact match should appear before partial match
      const exactMatch = results.find(
        (r) => r.node.name.toLowerCase() === "http" || r.node.displayName.toLowerCase() === "http"
      );
      const partialMatch = results.find(
        (r) =>
          r.node.name.toLowerCase() !== "http" &&
          r.node.displayName.toLowerCase() !== "http" &&
          (r.node.name.toLowerCase().includes("http") ||
            r.node.displayName.toLowerCase().includes("http"))
      );
      if (exactMatch && partialMatch) {
        expect(exactMatch.score).toBeGreaterThan(partialMatch.score);
      }
    }
  });

  test("default limit is 15", () => {
    // Use a very generic keyword that matches many nodes
    const results = searchNodes(["data"]);
    expect(results.length).toBeLessThanOrEqual(15);
  });
});
