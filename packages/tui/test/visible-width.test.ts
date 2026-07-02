/**
 * Tests for visibleWidth() grapheme width calculation.
 */

import assert from "node:assert";
import { describe, it } from "vitest";
import { truncateToWidth, visibleWidth } from "../src/utils.js";

describe("visibleWidth", () => {
  describe("combining marks (NFD text)", () => {
    it("should give decomposed (NFD) and precomposed (NFC) characters the same width", () => {
      // Vietnamese "ế": NFC = U+1EBF (1 code point), NFD = e + U+0302 + U+0301
      const nfc = "\u1ebf";
      const nfd = "e\u0302\u0301";
      assert.strictEqual(nfc.normalize("NFD"), nfd);
      assert.strictEqual(visibleWidth(nfc), 1);
      assert.strictEqual(visibleWidth(nfd), 1);
    });

    it("should count a base letter with two combining marks as width 1", () => {
      // a + combining acute (U+0301) + combining dot below (U+0323)
      assert.strictEqual(visibleWidth("a\u0301\u0323"), 1);
    });

    it("should measure NFD strings the same as their NFC form", () => {
      const nfc = "Vi\u1ec7t Nam \u1ebf\u1ec7"; // precomposed
      const nfd = nfc.normalize("NFD");
      assert.strictEqual(visibleWidth(nfd), visibleWidth(nfc));
    });

    it("should pad truncated NFD text to exactly maxWidth", () => {
      const nfd = "tri\u1ebfn khai".normalize("NFD");
      const padded = truncateToWidth(nfd, 6, "...", true);
      assert.strictEqual(visibleWidth(padded), 6);
    });
  });

  describe("emoji widths stay correct", () => {
    it("should keep single-codepoint emoji at width 2", () => {
      assert.strictEqual(visibleWidth("\u{1F44D}"), 2); // thumbs up
    });

    it("should keep ZWJ sequences at width 2", () => {
      assert.strictEqual(
        visibleWidth("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"), // family
        2,
      );
    });

    it("should keep skin-tone modified emoji at width 2", () => {
      assert.strictEqual(visibleWidth("\u{1F44D}\u{1F3FD}"), 2);
    });

    it("should keep regional-indicator flags at width 2", () => {
      assert.strictEqual(visibleWidth("\u{1F1FA}\u{1F1F8}"), 2); // US flag
    });

    it("should keep keycap sequences (VS16) at width 2", () => {
      assert.strictEqual(visibleWidth("1\uFE0F\u20E3"), 2);
    });
  });
});
