import { expect, test } from "vitest";
import { parseServerControl } from "../voice-session-protocol";

test("reply completion retains optional user-message correlation", () => {
  const frame = { t: "reply_complete", traceId: "turn-1" };
  expect(parseServerControl(JSON.stringify(frame))).toEqual(frame);
  const correlated = {
    ...frame,
    userMessageId: "12345678-1234-4234-8234-123456789abc",
  };
  expect(parseServerControl(JSON.stringify(correlated))).toEqual(correlated);
  // Saved user messages carry the deterministic elizaOS id (version nibble 0),
  // not an RFC 4122 version 1-5 id.
  const elizaId = {
    ...frame,
    userMessageId: "61342eca-9ca5-028a-b091-674194e39955",
  };
  expect(parseServerControl(JSON.stringify(elizaId))).toEqual(elizaId);
  for (const invalid of [
    { ...frame, traceId: "" },
    { ...frame, traceId: 42 },
    { ...frame, traceId: "x".repeat(257) },
    { ...frame, userMessageId: "not-a-message-id" },
    { ...frame, userMessageId: null },
  ])
    expect(parseServerControl(JSON.stringify(invalid))).toBeNull();
});
