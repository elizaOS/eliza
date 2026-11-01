import { expect, test } from "vitest";
import { parseServerControl } from "../voice-session-protocol";
import {
  applyServerEvent,
  INITIAL_VOICE_SESSION_STATE,
  type VoiceSessionMachineState,
} from "../voice-session-state";

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

test("activity frames show a content-free label only on the live thinking turn", () => {
  const frame = { t: "activity", label: "Using Calendar", traceId: "turn-1" };
  expect(parseServerControl(JSON.stringify(frame))).toEqual(frame);
  for (const invalid of [
    { ...frame, label: "" },
    { ...frame, label: "x".repeat(161) },
    { ...frame, traceId: "" },
  ])
    expect(parseServerControl(JSON.stringify(invalid))).toBeNull();
  const thinking: VoiceSessionMachineState = {
    ...INITIAL_VOICE_SESSION_STATE,
    phase: "thinking",
    traceId: "turn-1",
    progressText: "Let me have a look.",
  };
  const event = parseServerControl(JSON.stringify(frame));
  if (!event) throw new Error("activity frame was rejected");
  expect(applyServerEvent(thinking, event).progressText).toBe("Using Calendar");
  for (const stale of [
    { ...thinking, traceId: "turn-2" },
    { ...thinking, progressCancelledTraceId: "turn-1" },
    { ...thinking, phase: "listening" as const },
  ])
    expect(applyServerEvent(stale, event).progressText).toBe(
      stale.progressText,
    );
});
