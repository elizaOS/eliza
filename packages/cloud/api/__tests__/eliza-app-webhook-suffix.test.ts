/**
 * Path-traversal guard for the eliza-app webhook forwarder (finding L3, #12878).
 *
 * `_forward.ts` appends the request's trailing path onto the internal gateway
 * URL. These tests pin that only empty/benign safe-char suffixes survive, and
 * that any dot-segment or percent-encoded separator (which the URL parser leaves
 * intact) is rejected before it can escape `/webhook/<project>/<platform>`.
 */

import { describe, expect, mock, test } from "bun:test";

// Mock the logger before importing so loading the forwarder never pulls the
// real logger chain (core → @elizaos/cloud-routing).
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
}));

const { safeWebhookSuffix } = (await import(
  "../eliza-app/webhook/_forward"
)) as typeof import("../eliza-app/webhook/_forward");

const P = "telegram";
const base = `/api/eliza-app/webhook/${P}`;

describe("safeWebhookSuffix", () => {
  test("an exact-match path has an empty suffix", () => {
    expect(safeWebhookSuffix(base, P)).toBe("");
  });

  test("a bare trailing slash is normalized to empty", () => {
    expect(safeWebhookSuffix(`${base}/`, P)).toBe("");
  });

  test("a benign safe-char sub-path is preserved", () => {
    expect(safeWebhookSuffix(`${base}/inbound/v2`, P)).toBe("/inbound/v2");
  });

  test("a non-matching prefix yields empty (nothing to forward)", () => {
    expect(safeWebhookSuffix("/api/other/telegram", P)).toBe("");
  });

  test.each([
    `${base}/..`,
    `${base}/../admin`,
    `${base}/..%2fadmin`,
    `${base}/%2e%2e%2fadmin`,
    `${base}/foo%2f..%2fbar`,
    `${base}/foo/../bar`,
    `${base}/foo\\bar`,
    `${base}/foo.bar`,
    `${base}/foo%00`,
  ])("rejects a traversal/encoded suffix: %s", (pathname) => {
    expect(safeWebhookSuffix(pathname, P)).toBeNull();
  });
});
