/**
 * AOSP TEXT_TO_SPEECH handler tests. Kokoro is the only on-device TTS backend;
 * the handler dlopens the fused `libelizainference.so` and synthesizes through
 * the `eliza_inference_kokoro_*` ABI (see
 * `aosp-local-inference-bootstrap.test.ts` for the routing tests). These cases
 * verify the public TTS handler shape: pre-warm gating, foreground-skip
 * semantics, and abort handling against a mocked Kokoro handler.
 */
import { describe, expect, it } from "bun:test";
import {
  extractSpeechSignal,
  extractSpeechText,
  makeAospTextToSpeechHandler,
  prewarmAospKokoroTextToSpeechHandler,
} from "../src/aosp-local-inference-bootstrap";

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AOSP TEXT_TO_SPEECH handler", () => {
  it("returns the Kokoro FFI handler output verbatim", async () => {
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    const handler = makeAospTextToSpeechHandler({
      kokoro: async () => wav,
    });
    await expect(
      handler({} as never, { text: "Hello from Android." }),
    ).resolves.toEqual(wav);
  });

  it("propagates abort-style failures from the Kokoro FFI binding", async () => {
    const handler = makeAospTextToSpeechHandler({
      kokoro: async () => {
        throw new Error("[aosp-local-inference] TEXT_TO_SPEECH aborted");
      },
    });
    await expect(handler({} as never, { text: "cancel me" })).rejects.toThrow(
      /aborted/,
    );
  });

  it("propagates a missing-FFI failure without falling back", async () => {
    const handler = makeAospTextToSpeechHandler({
      kokoro: async () => {
        throw new Error("fused Kokoro TEXT_TO_SPEECH is not available");
      },
    });
    await expect(handler({} as never, "hello")).rejects.toThrow(
      /fused Kokoro TEXT_TO_SPEECH is not available/,
    );
  });

  it("only pre-warms when explicitly enabled", async () => {
    let calls = 0;
    const handler = async () => {
      calls++;
      return new Uint8Array([0, 1, 2, 3]);
    };

    await withEnv(
      {
        ELIZA_AOSP_TTS_PREWARM: undefined,
        ELIZA_AOSP_TTS_PREWARM_DELAY_MS: "1",
      },
      async () => {
        prewarmAospKokoroTextToSpeechHandler(handler);
        await wait(10);
      },
    );
    expect(calls).toBe(0);

    await withEnv(
      {
        ELIZA_AOSP_TTS_PREWARM: "1",
        ELIZA_AOSP_TTS_PREWARM_DELAY_MS: "1",
        ELIZA_AOSP_TTS_PREWARM_TIMEOUT_MS: "100",
      },
      async () => {
        prewarmAospKokoroTextToSpeechHandler(handler);
        await wait(10);
      },
    );
    expect(calls).toBe(1);
  });

  it("skips delayed pre-warm when foreground TTS already ran", async () => {
    let calls = 0;
    const handler = async () => {
      calls++;
      return new Uint8Array([0, 1, 2, 3]);
    };

    await withEnv(
      {
        ELIZA_AOSP_TTS_PREWARM: "1",
        ELIZA_AOSP_TTS_PREWARM_DELAY_MS: "1",
        ELIZA_AOSP_TTS_PREWARM_TIMEOUT_MS: "100",
      },
      async () => {
        prewarmAospKokoroTextToSpeechHandler(handler, {
          shouldSkip: () => true,
        });
        await wait(10);
      },
    );

    expect(calls).toBe(0);
  });
});

// Fuzz / robustness — the TEXT_TO_SPEECH input-parsing contract
// (extractSpeechText / extractSpeechSignal) is what every request passes through
// before the native Kokoro FFI. It must round-trip valid inputs, reject
// malformed shapes with the typed error, and never crash on adversarial text.
describe("AOSP TEXT_TO_SPEECH input contract — fuzz / robustness", () => {
  function randText(): string {
    const pools = [
      "abcdefghijklmnopqrstuvwxyz ",
      "  \t\n\r  ", // whitespace-only
      "日本語のテスト。café — naïve — 😀🎙️", // unicode + emoji
      "<script>alert(1)</script> & \0 \x07 control", // markup + control chars
      "word ".repeat(2000), // very long
    ];
    const pool = pools[Math.floor(Math.random() * pools.length)] ?? "a";
    const len = 1 + Math.floor(Math.random() * 64);
    let s = "";
    for (let i = 0; i < len; i++)
      s += pool[Math.floor(Math.random() * pool.length)] ?? "";
    return s;
  }

  it("extractSpeechText round-trips 200 random string / { text } inputs verbatim", () => {
    for (let i = 0; i < 200; i++) {
      const text = randText();
      // Passed as a bare string and as { text } — both must return the exact
      // bytes (no trimming/mutation at the extractor layer; the handler trims).
      expect(extractSpeechText(text)).toBe(text);
      expect(extractSpeechText({ text })).toBe(text);
    }
  });

  it("extractSpeechText rejects every malformed shape with the typed input error", () => {
    const bad: unknown[] = [
      123,
      null,
      undefined,
      {},
      { text: 123 },
      { text: null },
      [],
      true,
      { notText: "x" },
      Symbol("s"),
    ];
    for (const params of bad) {
      expect(() => extractSpeechText(params as never)).toThrow(
        /requires a string or \{ text \}/,
      );
    }
  });

  it("extractSpeechSignal recovers the signal only from object params, never crashes", () => {
    const ac = new AbortController();
    expect(extractSpeechSignal({ text: "hi", signal: ac.signal })).toBe(
      ac.signal,
    );
    // Bare string / signal-less object / adversarial shapes → undefined, no throw.
    for (const p of ["hello", { text: "x" }, {}, [] as never]) {
      expect(extractSpeechSignal(p as never)).toBeUndefined();
    }
  });
});
