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
  for (const invalid of [
    { ...frame, traceId: "" },
    { ...frame, traceId: 42 },
    { ...frame, traceId: "x".repeat(257) },
    { ...frame, userMessageId: "not-a-message-id" },
    { ...frame, userMessageId: null },
  ])
    expect(parseServerControl(JSON.stringify(invalid))).toBeNull();
});
