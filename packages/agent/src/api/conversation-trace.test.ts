/** Exercises the closed-schema conversation trace boundary without network mocks. */

import { describe, expect, it } from "vitest";
import {
  ELIZA_TRACE_ID_HEADER,
  resolveConversationTraceContext,
} from "./conversation-trace.ts";

describe("conversation trace context", () => {
  it("adopts the exact lowercase 32-hex inbound identifier", () => {
    const traceId = "0123456789abcdef0123456789abcdef";
    expect(
      resolveConversationTraceContext({
        [ELIZA_TRACE_ID_HEADER.toLowerCase()]: traceId,
      }),
    ).toEqual({ traceId, source: "inbound" });
  });

  it.each([
    undefined,
    "",
    "0123456789ABCDEF0123456789ABCDEF",
    "11111111-1111-4111-8111-111111111111",
    "private bearer-like text",
    ["0123456789abcdef0123456789abcdef"],
  ])("discards absent or invalid caller text and mints a fresh id", (value) => {
    const resolved = resolveConversationTraceContext({
      [ELIZA_TRACE_ID_HEADER.toLowerCase()]: value,
    });
    expect(resolved.source).toBe("minted");
    expect(resolved.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(resolved.traceId).not.toBe(value);
  });
});
