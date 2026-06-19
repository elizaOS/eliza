/**
 * AOSP TEXT_TO_SPEECH handler tests. (Filename retained for git history;
 * the Kokoro/ONNX path was removed alongside `onnxruntime-web` in favour
 * of the fused OmniVoice FFI binding — see `aosp-omnivoice-tts-handler`
 * coverage in `aosp-local-inference-bootstrap.test.ts` for the routing
 * tests. These cases verify the public TTS handler shape: pre-warm
 * gating, foreground-skip semantics, and abort handling against a mocked
 * OmniVoice handler.)
 */
import { describe, expect, it } from "bun:test";
import {
  makeAospTextToSpeechHandler,
  prewarmAospOmnivoiceTextToSpeechHandler,
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
  it("returns the OmniVoice FFI handler output verbatim", async () => {
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    const handler = makeAospTextToSpeechHandler({
      omnivoice: async () => wav,
    });
    await expect(handler({} as never, { text: "Hello from Android." }))
      .resolves
      .toEqual(wav);
  });

  it("propagates abort-style failures from the OmniVoice FFI binding", async () => {
    const handler = makeAospTextToSpeechHandler({
      omnivoice: async () => {
        throw new Error("[aosp-local-inference] TEXT_TO_SPEECH aborted");
      },
    });
    await expect(
      handler({} as never, { text: "cancel me" }),
    ).rejects.toThrow(/aborted/);
  });

  it("propagates a missing-FFI failure without falling back", async () => {
    const handler = makeAospTextToSpeechHandler({
      omnivoice: async () => {
        throw new Error("fused OmniVoice TEXT_TO_SPEECH is not available");
      },
    });
    await expect(
      handler({} as never, "hello"),
    ).rejects.toThrow(/fused OmniVoice TEXT_TO_SPEECH is not available/);
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
        prewarmAospOmnivoiceTextToSpeechHandler(handler);
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
        prewarmAospOmnivoiceTextToSpeechHandler(handler);
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
        prewarmAospOmnivoiceTextToSpeechHandler(handler, {
          shouldSkip: () => true,
        });
        await wait(10);
      },
    );

    expect(calls).toBe(0);
  });
});
