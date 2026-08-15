// @vitest-environment node
//
// #11294: OSC 52 clipboard escape for /copy.

import { describe, expect, it } from "bun:test";
import { osc52 } from "./clipboard.js";

describe("osc52 (#11294)", () => {
  it("wraps base64-encoded UTF-8 in the OSC 52 clipboard sequence", () => {
    const seq = osc52("hello");
    expect(seq.startsWith("\x1b]52;c;")).toBe(true);
    expect(seq.endsWith("\x07")).toBe(true);
    const b64 = seq.slice("\x1b]52;c;".length, -1);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("hello");
  });

  it("round-trips multi-line and unicode content", () => {
    const text = "line one\nline two — ✅ 你好";
    const seq = osc52(text);
    const b64 = seq.slice("\x1b]52;c;".length, -1);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(text);
  });
});
