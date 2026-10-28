import { expect, test } from "vitest";
import {
  decodeSpeechRelayAudio,
  encodeSpeechRelayAudio,
  parseSpeechRelayJson,
  SPEECH_RELAY_ROUTES,
} from "./speech-relay-wire";

test("strict speech wire shares exact routes and binary context-bound PCM", () => {
  expect(SPEECH_RELAY_ROUTES.mint).toBe("/api/v1/voice/speech/session");
  expect(SPEECH_RELAY_ROUTES.revoke("owned")).toBe(
    "/api/v1/voice/speech/session/owned/revoke",
  );
  expect(
    parseSpeechRelayJson('{"t":"tts","id":"turn","text":"hello","flush":true}'),
  ).toEqual({ t: "tts", id: "turn", text: "hello", flush: true });
  expect(parseSpeechRelayJson('{"t":"finish","id":"turn"}')).toEqual({
    t: "finish",
    id: "turn",
  });
  expect(parseSpeechRelayJson('{"t":"hello","token":"x"}')).toEqual({
    t: "hello",
    token: "x",
  });
  expect(
    parseSpeechRelayJson('{"t":"hello","token":"x","errorReasons":true}'),
  ).toEqual({ t: "hello", token: "x", errorReasons: true });
  const pcm = new Uint8Array([1, 2, 3, 4]);
  expect(decodeSpeechRelayAudio(encodeSpeechRelayAudio("turn", pcm))).toEqual({
    id: "turn",
    pcm,
  });
});
test("wire rejects unknown controls, leaked account fields, oversized strings and malformed audio", () => {
  for (const frame of [
    '{"t":"hello","token":"x","apiKey":"vendor"}',
    '{"t":"hello","token":"x","errorReasons":false}',
    '{"t":"hello","token":"x","errorReasons":"true"}',
    '{"t":"hello","token":"x","errorReasons":true,"extra":1}',
    '{"t":"tts","id":"t","text":"x","model":"arbitrary"}',
    '{"t":"stop","url":"https://evil.test"}',
    "x".repeat(8193),
  ])
    expect(() => parseSpeechRelayJson(frame)).toThrow();
  for (const frame of [
    new Uint8Array([0, 1, 65, 1, 2]),
    new Uint8Array([1, 2, 65]),
    new Uint8Array([1, 1, 65, 1]),
  ])
    expect(() => decodeSpeechRelayAudio(frame)).toThrow();
});
