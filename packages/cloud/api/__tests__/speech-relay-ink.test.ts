import { expect, test } from "bun:test";
import { speechRelayInkFactory } from "../src/speech-relay-ink";

test("speech-only factory preserves provider auth/format and applies bounded responsive turn detection", () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const socket = {
    readyState: 1,
    send() {},
    close() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const factory = speechRelayInkFactory((request) => {
    calls.push(request);
    return socket;
  });
  const request = {
    url: "wss://api.cartesia.ai/stt/turns/websocket?model=ink-2&encoding=pcm_s16le&sample_rate=16000&turn_end_timeout_ms=8000",
    headers: { "X-API-Key": "held-on-server" },
  };
  expect(factory(request)).toBe(socket);
  expect(calls[0].headers).toBe(request.headers);
  const params = new URL(calls[0].url).searchParams;
  expect(params.get("model")).toBe("ink-2");
  expect(params.get("sample_rate")).toBe("16000");
  expect(params.get("turn_start_threshold")).toBe("0.7");
  expect(params.get("turn_eager_end_threshold")).toBe("0.6");
  expect(params.get("turn_end_threshold")).toBe("0.4");
  expect(params.get("turn_end_timeout_ms")).toBe("1280");
  for (const [value, expected] of [
    ["1", "640"],
    ["99000", "5000"],
    ["2000", "2000"],
  ]) {
    speechRelayInkFactory((request) => {
      expect(new URL(request.url).searchParams.get("turn_end_timeout_ms")).toBe(
        expected,
      );
      return socket;
    }, value)(request);
  }
  expect(() => speechRelayInkFactory(() => socket, "invalid")).toThrow();
});
