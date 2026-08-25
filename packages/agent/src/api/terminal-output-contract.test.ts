/**
 * Covers capturedTerminalOutputIsSafe and MAX_TERMINAL_CAPTURE_BYTES: well-formed
 * UTF-16 (paired vs lone surrogates), the allow-list of C0 controls, DEL,
 * U+FFFD, bidi embeddings/overrides/isolates, per-stream vs combined UTF-8
 * byte budget, and empty / single-stream / both-stream inputs. Drives the
 * real module; no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  capturedTerminalOutputIsSafe,
  MAX_TERMINAL_CAPTURE_BYTES,
} from "./terminal-output-contract.ts";

const HIGH_SURROGATE = String.fromCharCode(0xd800);
const LOW_SURROGATE = String.fromCharCode(0xdc00);
const PAIRED_GRIN = "\uD83D\uDE00"; // U+1F600, two well-formed UTF-16 units

describe("MAX_TERMINAL_CAPTURE_BYTES", () => {
  it("is 4 MiB", () => {
    expect(MAX_TERMINAL_CAPTURE_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe("capturedTerminalOutputIsSafe", () => {
  describe("empty and single-stream inputs", () => {
    it("accepts empty stdout and empty stderr", () => {
      expect(capturedTerminalOutputIsSafe("", "")).toBe(true);
    });

    it("accepts stdout only", () => {
      expect(capturedTerminalOutputIsSafe("hello", "")).toBe(true);
    });

    it("accepts stderr only", () => {
      expect(capturedTerminalOutputIsSafe("", "warn")).toBe(true);
    });

    it("accepts both streams with printable ASCII", () => {
      expect(capturedTerminalOutputIsSafe("out", "err")).toBe(true);
    });
  });

  describe("allowed control characters and well-formed text", () => {
    it("allows tab, line feed, carriage return, and ESC in either stream", () => {
      const allowed = "\t\n\r\u001b";
      expect(capturedTerminalOutputIsSafe(allowed, "")).toBe(true);
      expect(capturedTerminalOutputIsSafe("", allowed)).toBe(true);
      expect(capturedTerminalOutputIsSafe(allowed, allowed)).toBe(true);
    });

    it("allows ANSI CSI color sequences that start with ESC", () => {
      expect(capturedTerminalOutputIsSafe("\u001b[31mred\u001b[0m", "")).toBe(
        true,
      );
    });

    it("allows space and the rest of printable ASCII", () => {
      const printable = " ~!@#$%^&*()[]{}|\\/;:'\",.<>?0123456789AaZz";
      expect(capturedTerminalOutputIsSafe(printable, printable)).toBe(true);
    });

    it("allows well-formed BMP Unicode", () => {
      expect(capturedTerminalOutputIsSafe("café — 漢字", "αβγ")).toBe(true);
    });

    it("allows well-formed supplementary-plane pairs (emoji)", () => {
      expect(capturedTerminalOutputIsSafe(PAIRED_GRIN, `${PAIRED_GRIN}x`)).toBe(
        true,
      );
    });

    it("allows C1 controls that the contract does not list as unsafe", () => {
      expect(capturedTerminalOutputIsSafe("\u0080\u009b", "")).toBe(true);
    });
  });

  describe("lone and mismatched UTF-16 surrogates", () => {
    it("rejects a lone high surrogate in stdout", () => {
      expect(capturedTerminalOutputIsSafe(HIGH_SURROGATE, "")).toBe(false);
    });

    it("rejects a lone high surrogate in stderr", () => {
      expect(capturedTerminalOutputIsSafe("", HIGH_SURROGATE)).toBe(false);
    });

    it("rejects a lone low surrogate in stdout", () => {
      expect(capturedTerminalOutputIsSafe(LOW_SURROGATE, "")).toBe(false);
    });

    it("rejects a lone low surrogate in stderr", () => {
      expect(capturedTerminalOutputIsSafe("", LOW_SURROGATE)).toBe(false);
    });

    it("rejects a high surrogate at the end of an otherwise safe string", () => {
      expect(capturedTerminalOutputIsSafe(`ok${HIGH_SURROGATE}`, "")).toBe(
        false,
      );
    });

    it("rejects a high surrogate followed by another high surrogate", () => {
      expect(
        capturedTerminalOutputIsSafe(HIGH_SURROGATE + HIGH_SURROGATE, ""),
      ).toBe(false);
    });

    it("rejects a high surrogate followed by a non-low BMP character", () => {
      expect(capturedTerminalOutputIsSafe(`${HIGH_SURROGATE}A`, "")).toBe(
        false,
      );
    });

    it("rejects an unpaired low surrogate between safe characters", () => {
      expect(capturedTerminalOutputIsSafe(`a${LOW_SURROGATE}b`, "")).toBe(
        false,
      );
    });

    it("rejects a valid pair followed by a trailing high surrogate", () => {
      expect(
        capturedTerminalOutputIsSafe(`${PAIRED_GRIN}${HIGH_SURROGATE}`, ""),
      ).toBe(false);
    });
  });

  describe("disallowed code points", () => {
    it("rejects NUL and other C0 controls outside the allow-list in stdout", () => {
      expect(capturedTerminalOutputIsSafe("\u0000", "")).toBe(false);
      expect(capturedTerminalOutputIsSafe("\u0001", "")).toBe(false);
      expect(capturedTerminalOutputIsSafe("\u0008", "")).toBe(false);
      expect(capturedTerminalOutputIsSafe("\u000b", "")).toBe(false);
      expect(capturedTerminalOutputIsSafe("\u000c", "")).toBe(false);
      expect(capturedTerminalOutputIsSafe("\u001a", "")).toBe(false);
      expect(capturedTerminalOutputIsSafe("\u001f", "")).toBe(false);
    });

    it("rejects the same disallowed C0 controls in stderr", () => {
      expect(capturedTerminalOutputIsSafe("", "\u0000")).toBe(false);
      expect(capturedTerminalOutputIsSafe("", "\u0008")).toBe(false);
      expect(capturedTerminalOutputIsSafe("", "\u001f")).toBe(false);
    });

    it("treats 0x08/0x0b/0x0c/0x1a as unsafe while neighbouring allow-list bytes stay safe", () => {
      expect(capturedTerminalOutputIsSafe("\t", "")).toBe(true);
      expect(capturedTerminalOutputIsSafe("\u0008", "")).toBe(false);
      expect(capturedTerminalOutputIsSafe("\n", "")).toBe(true);
      expect(capturedTerminalOutputIsSafe("\u000b", "")).toBe(false);
      expect(capturedTerminalOutputIsSafe("\r", "")).toBe(true);
      expect(capturedTerminalOutputIsSafe("\u000c", "")).toBe(false);
      expect(capturedTerminalOutputIsSafe("\u001b", "")).toBe(true);
      expect(capturedTerminalOutputIsSafe("\u001a", "")).toBe(false);
    });

    it("rejects DEL (U+007F) in either stream", () => {
      expect(capturedTerminalOutputIsSafe("\u007f", "")).toBe(false);
      expect(capturedTerminalOutputIsSafe("", "ok\u007f")).toBe(false);
      expect(capturedTerminalOutputIsSafe("~", "")).toBe(true);
    });

    it("rejects the Unicode replacement character (U+FFFD)", () => {
      expect(capturedTerminalOutputIsSafe("\uFFFD", "")).toBe(false);
      expect(capturedTerminalOutputIsSafe("", "lossy\uFFFD")).toBe(false);
    });

    it("rejects bidi embeddings and overrides U+202A..U+202E", () => {
      for (const point of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e]) {
        const mark = String.fromCodePoint(point);
        expect(capturedTerminalOutputIsSafe(mark, "")).toBe(false);
        expect(capturedTerminalOutputIsSafe("", `x${mark}`)).toBe(false);
      }
      expect(capturedTerminalOutputIsSafe("\u2029", "")).toBe(true);
    });

    it("rejects bidi isolates U+2066..U+2069", () => {
      for (const point of [0x2066, 0x2067, 0x2068, 0x2069]) {
        const mark = String.fromCodePoint(point);
        expect(capturedTerminalOutputIsSafe(mark, "")).toBe(false);
        expect(capturedTerminalOutputIsSafe("", mark)).toBe(false);
      }
      expect(capturedTerminalOutputIsSafe("\u2065", "")).toBe(true);
      expect(capturedTerminalOutputIsSafe("\u206a", "")).toBe(true);
    });

    it("fails closed when only one stream is unsafe", () => {
      expect(capturedTerminalOutputIsSafe("ok", "\u0000")).toBe(false);
      expect(capturedTerminalOutputIsSafe("\uFFFD", "ok")).toBe(false);
    });
  });

  describe("combined UTF-8 byte budget", () => {
    it("accepts stdout that occupies the entire budget", () => {
      const stdout = "a".repeat(MAX_TERMINAL_CAPTURE_BYTES);
      expect(capturedTerminalOutputIsSafe(stdout, "")).toBe(true);
    });

    it("accepts stderr that occupies the entire budget", () => {
      const stderr = "b".repeat(MAX_TERMINAL_CAPTURE_BYTES);
      expect(capturedTerminalOutputIsSafe("", stderr)).toBe(true);
    });

    it("accepts a split that sums to exactly the budget", () => {
      const stdout = "a".repeat(MAX_TERMINAL_CAPTURE_BYTES - 3);
      expect(capturedTerminalOutputIsSafe(stdout, "err")).toBe(true);
    });

    it("rejects stdout one byte over the budget", () => {
      const stdout = "a".repeat(MAX_TERMINAL_CAPTURE_BYTES + 1);
      expect(capturedTerminalOutputIsSafe(stdout, "")).toBe(false);
    });

    it("rejects stderr one byte over the budget", () => {
      const stderr = "b".repeat(MAX_TERMINAL_CAPTURE_BYTES + 1);
      expect(capturedTerminalOutputIsSafe("", stderr)).toBe(false);
    });

    it("rejects a combined overflow when each stream is under the cap", () => {
      const stdout = "a".repeat(MAX_TERMINAL_CAPTURE_BYTES);
      expect(capturedTerminalOutputIsSafe(stdout, "x")).toBe(false);
    });

    it("counts UTF-8 bytes, not UTF-16 units", () => {
      // U+00E9 is one JS string unit and two UTF-8 bytes.
      const almost = "é".repeat(MAX_TERMINAL_CAPTURE_BYTES / 2);
      expect(Buffer.byteLength(almost, "utf8")).toBe(
        MAX_TERMINAL_CAPTURE_BYTES,
      );
      expect(capturedTerminalOutputIsSafe(almost, "")).toBe(true);
      expect(capturedTerminalOutputIsSafe(`${almost}x`, "")).toBe(false);
    });

    it("counts a 4-byte emoji against the budget", () => {
      expect(Buffer.byteLength(PAIRED_GRIN, "utf8")).toBe(4);
      const count = MAX_TERMINAL_CAPTURE_BYTES / 4;
      const exact = PAIRED_GRIN.repeat(count);
      expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_TERMINAL_CAPTURE_BYTES);
      expect(capturedTerminalOutputIsSafe(exact, "")).toBe(true);
      expect(capturedTerminalOutputIsSafe(exact + PAIRED_GRIN, "")).toBe(false);
    });
  });
});
