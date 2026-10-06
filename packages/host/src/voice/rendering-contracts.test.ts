/** Pure transport serialization and phrase-buffer contracts; no provider or audio I/O. */
import { describe, expect, it, vi } from "vitest";
import {
  CartesiaSonicTtsAdapter,
  type CartesiaWebSocketLike,
} from "./cartesia-sonic-tts.ts";
import { PhraseAggregator } from "./phrase-aggregator.ts";

describe("Cartesia request serialization", () => {
  it.each([
    [{}, ""],
    [
      { maxBufferDelayMs: 0, flush: false, duration: 0 },
      ',"max_buffer_delay_ms":0,"flush":false,"duration":0',
    ],
  ])(
    "preserves exact JSON bytes and optional values: %j",
    (options, suffix) => {
      const socket: CartesiaWebSocketLike = {
        readyState: 1,
        binaryType: "arraybuffer",
        send: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      const adapter = new CartesiaSonicTtsAdapter({
        apiKey: "unit-test-key",
        voiceId: "11111111-1111-4111-8111-111111111111",
        websocketFactory: () => socket,
      });
      const stream = adapter.createStream({ contextId: "test-context" }, {});
      stream.sendPhrase({
        text: "Hello 🌙",
        continueContext: true,
        ...options,
      });
      expect(socket.send).toHaveBeenCalledExactlyOnceWith(
        '{"model_id":"sonic-3.5","transcript":"Hello 🌙","voice":{"mode":"id","id":"11111111-1111-4111-8111-111111111111"},"language":"en","context_id":"test-context","output_format":{"container":"raw","encoding":"pcm_s16le","sample_rate":16000},"continue":true' +
          suffix +
          "}",
      );
      stream.cancel();
      adapter.close();
    },
  );
});

describe("PhraseAggregator public flush contract", () => {
  it("does not make internal phrase boundaries dispatch a public flush override", () => {
    class CustomFlush extends PhraseAggregator {
      override flush(): string {
        return "custom flush";
      }
    }
    const phrases = new CustomFlush();
    expect(phrases.push("Hello.")).toEqual(["Hello."]);
    expect(phrases.emitted).toBe(1);
    expect(phrases.flush()).toBe("custom flush");
  });

  it("shares draining across sentence boundaries and the trailing phrase", () => {
    const phrases = new PhraseAggregator();
    expect(phrases.push("Hello. Tail")).toEqual(["Hello."]);
    expect(phrases.emitted).toBe(1);
    expect(phrases.flush()).toBe("Tail");
    expect(phrases.flush()).toBeNull();
    expect(phrases.emitted).toBe(2);
  });

  it("discards short and reset buffers without counting an emission", () => {
    const phrases = new PhraseAggregator();
    expect(phrases.push("x")).toEqual([]);
    expect(phrases.flush()).toBeNull();
    expect(phrases.push("discarded")).toEqual([]);
    phrases.reset();
    expect(phrases.flush()).toBeNull();
    expect(phrases.emitted).toBe(0);
  });

  it("preserves word-boundary spacing at the maximum buffer", () => {
    const phrases = new PhraseAggregator({
      maxBufferChars: 5,
      preferWordBoundaryAtMax: true,
    });
    expect(phrases.push("hello world")).toEqual(["hello "]);
    expect(phrases.flush()).toBe("world");
    expect(phrases.emitted).toBe(2);
  });
});
