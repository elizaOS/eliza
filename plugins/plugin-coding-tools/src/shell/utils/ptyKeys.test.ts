/**
 * Unit tests for ptyKeys: validates ANSI/VT100 key sequence encoder and terminal DSR filters.
 */
import { describe, expect, it } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  buildCursorPositionResponse,
  encodeKeySequence,
  encodePaste,
  stripDsrRequests,
} from "./ptyKeys.ts";

describe("ptyKeys", () => {
  it("encodes named keys and modifiers to terminal escape codes", () => {
    const result = encodeKeySequence({
      keys: ["enter", "tab", "backspace", "up", "down"],
    });
    expect(result.data).toBe("\r\t\x7f\x1b[A\x1b[B");
    expect(result.warnings).toEqual([]);
  });

  it("encodes Emacs and caret modifier combinations and hex bytes", () => {
    const result = encodeKeySequence({
      keys: ["C-c", "^d", "M-a"],
      hex: ["0x0a"],
      literal: "echo ",
    });
    expect(result.data).toBe("echo \n\x03\x04\x1ba");
    expect(result.warnings).toEqual([]);
  });

  it("wraps text in bracketed paste escape sequences", () => {
    const text = "const x = 42;";
    expect(encodePaste(text, true)).toBe(
      `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`,
    );
    expect(encodePaste(text, false)).toBe(text);
  });

  it("detects and strips DSR requests from terminal stream", () => {
    const withDsr = "prompt> \x1b[6noutput text";
    const stripped = stripDsrRequests(withDsr);
    expect(stripped.requests).toBe(1);
    expect(stripped.cleaned).toBe("prompt> output text");

    const withoutDsr = "regular terminal output\r\n";
    expect(stripDsrRequests(withoutDsr)).toEqual({
      cleaned: withoutDsr,
      requests: 0,
    });
  });

  it("builds cursor position CPR response sequence", () => {
    expect(buildCursorPositionResponse(10, 25)).toBe("\x1b[10;25R");
    expect(buildCursorPositionResponse()).toBe("\x1b[1;1R");
  });
});
