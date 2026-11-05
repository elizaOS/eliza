import { expect, test } from "vitest";
import { readConfirmedSpeechRetirement } from "./speech-relay-wire";

const id = "00000000-0000-4000-8000-000000000001";
const now = Date.parse("2026-11-02T00:00:00Z");
const proof = () => ({
  revoked: true,
  retirement: {
    version: 1,
    sessionId: id,
    state: "confirmed",
    completedAt: new Date(now).toISOString(),
    mode: "retired",
    stt: "gracefully_drained",
    tts: "transport_closed",
    accounting: "settled_actual",
  },
});
test("accepts exact confirmed outcome and byte-equivalent old replay", () => {
  expect(readConfirmedSpeechRetirement(proof(), id, now)).not.toBeNull();
  expect(
    readConfirmedSpeechRetirement(proof(), id, now + 86400000),
  ).not.toBeNull();
});
test("accepts truthful never-started combination", () => {
  const p = proof();
  Object.assign(p.retirement, {
    mode: "never_started",
    stt: "not_dispatched",
    tts: "not_dispatched",
    accounting: "not_started",
  });
  expect(readConfirmedSpeechRetirement(p, id, now)).not.toBeNull();
});
test.each([
  ["bare boolean", { revoked: true }],
  [
    "unknown outcome",
    {
      revoked: false,
      retirement: {
        version: 1,
        sessionId: id,
        state: "unconfirmed",
        reason: "legacy_state",
      },
    },
  ],
  ["extra outer field", { ...proof(), extra: true }],
])("rejects %s", (_name, value) =>
  expect(readConfirmedSpeechRetirement(value, id, now)).toBeNull(),
);
test.each([
  ["sessionId", "other"],
  ["version", 2],
  ["accounting", "not_started"],
  ["stt", ["gracefully_drained"]],
  ["tts", "unknown"],
  ["completedAt", "tomorrow"],
  ["completedAt", new Date(now + 31000).toISOString()],
  ["extra", true],
])("rejects invalid nested %s=%s", (key, value) => {
  const p = proof();
  Object.assign(p.retirement, { [key]: value });
  expect(readConfirmedSpeechRetirement(p, id, now)).toBeNull();
});
test("never-started mode cannot contain dispatched provider claims", () => {
  const p = proof();
  Object.assign(p.retirement, {
    mode: "never_started",
    accounting: "not_started",
  });
  expect(readConfirmedSpeechRetirement(p, id, now)).toBeNull();
});
