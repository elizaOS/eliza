/**
 * ANSI wrapping tests verify that style open and reset sequences remain scoped
 * to the wrapped text segments they decorate.
 */

import assert from "node:assert";
import { describe, it } from "vitest";
import { visibleWidth, wrapTextWithAnsi } from "../src/utils.js";

describe("wrapTextWithAnsi", () => {
  describe("underline styling", () => {
    it("should not apply underline style before the styled text", () => {
      const underlineOn = "\x1b[4m";
      const underlineOff = "\x1b[24m";
      const url = "https://example.com/very/long/path/that/will/wrap";
      const text = `read this thread ${underlineOn}${url}${underlineOff}`;

      const wrapped = wrapTextWithAnsi(text, 40);

      assert.strictEqual(wrapped[0], "read this thread");

      assert.strictEqual(wrapped[1].startsWith(underlineOn), true);
      assert.ok(wrapped[1].includes("https://"));
    });

    it("should not have whitespace before underline reset code", () => {
      const underlineOn = "\x1b[4m";
      const underlineOff = "\x1b[24m";
      const textWithUnderlinedTrailingSpace = `${underlineOn}underlined text here ${underlineOff}more`;

      const wrapped = wrapTextWithAnsi(textWithUnderlinedTrailingSpace, 18);

      assert.ok(!wrapped[0].includes(` ${underlineOff}`));
    });

    it("should not bleed underline to padding - each line should end with reset for underline only", () => {
      const underlineOn = "\x1b[4m";
      const underlineOff = "\x1b[24m";
      const url =
        "https://example.com/very/long/path/that/will/definitely/wrap";
      const text = `prefix ${underlineOn}${url}${underlineOff} suffix`;

      const wrapped = wrapTextWithAnsi(text, 30);

      for (let i = 1; i < wrapped.length - 1; i++) {
        const line = wrapped[i];
        if (line.includes(underlineOn)) {
          assert.strictEqual(line.endsWith(underlineOff), true);
          assert.strictEqual(line.endsWith("\x1b[0m"), false);
        }
      }
    });
  });

  describe("background color preservation", () => {
    it("should preserve background color across wrapped lines without full reset", () => {
      const bgBlue = "\x1b[44m";
      const reset = "\x1b[0m";
      const text = `${bgBlue}hello world this is blue background text${reset}`;

      const wrapped = wrapTextWithAnsi(text, 15);

      for (const line of wrapped) {
        assert.ok(line.includes(bgBlue));
      }

      for (let i = 0; i < wrapped.length - 1; i++) {
        assert.strictEqual(wrapped[i].endsWith("\x1b[0m"), false);
      }
    });

    it("should reset underline but preserve background when wrapping underlined text inside background", () => {
      const underlineOn = "\x1b[4m";
      const underlineOff = "\x1b[24m";
      const reset = "\x1b[0m";

      const text = `\x1b[41mprefix ${underlineOn}UNDERLINED_CONTENT_THAT_WRAPS${underlineOff} suffix${reset}`;

      const wrapped = wrapTextWithAnsi(text, 20);

      for (const line of wrapped) {
        const hasBgColor =
          line.includes("[41m") ||
          line.includes(";41m") ||
          line.includes("[41;");
        assert.ok(hasBgColor);
      }

      for (let i = 0; i < wrapped.length - 1; i++) {
        const line = wrapped[i];
        if (
          (line.includes("[4m") ||
            line.includes("[4;") ||
            line.includes(";4m")) &&
          !line.includes(underlineOff)
        ) {
          assert.strictEqual(line.endsWith(underlineOff), true);
          assert.strictEqual(line.endsWith("\x1b[0m"), false);
        }
      }
    });
  });

  describe("basic wrapping", () => {
    it("should wrap plain text correctly", () => {
      const text = "hello world this is a test";
      const wrapped = wrapTextWithAnsi(text, 10);

      assert.ok(wrapped.length > 1);
      for (const line of wrapped) {
        assert.ok(visibleWidth(line) <= 10);
      }
    });

    it("should truncate trailing whitespace that exceeds width", () => {
      const twoSpacesWrappedToWidth1 = wrapTextWithAnsi("  ", 1);
      assert.ok(visibleWidth(twoSpacesWrappedToWidth1[0]) <= 1);
    });

    it("should preserve color codes across wraps", () => {
      const red = "\x1b[31m";
      const reset = "\x1b[0m";
      const text = `${red}hello world this is red${reset}`;

      const wrapped = wrapTextWithAnsi(text, 10);

      for (let i = 1; i < wrapped.length; i++) {
        assert.strictEqual(wrapped[i].startsWith(red), true);
      }

      for (let i = 0; i < wrapped.length - 1; i++) {
        assert.strictEqual(wrapped[i].endsWith("\x1b[0m"), false);
      }
    });
  });
});
