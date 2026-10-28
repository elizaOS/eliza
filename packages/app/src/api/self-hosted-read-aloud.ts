/** Owned, bounded text-only speech using the same Sonic adapter as voice sessions. */
import {
  type CartesiaSonicAdapterConfig,
  CartesiaSonicTtsAdapter,
} from "@elizaos/host/voice/cartesia-sonic-tts";
import { encodePcm16Wav } from "@elizaos/voice/browser-capture";

export async function synthesizeDirectReadAloud(input: {
  text: string;
  signal: AbortSignal;
  beforeDispatch: () => Promise<void>;
  config: CartesiaSonicAdapterConfig;
}): Promise<Uint8Array> {
  input.signal.throwIfAborted();
  if (!input.text.trim() || input.text.length > 16000)
    throw Error("Invalid read-aloud text");
  await input.beforeDispatch();
  input.signal.throwIfAborted();
  const adapter = new CartesiaSonicTtsAdapter({
    ...input.config,
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_s16le",
  });
  const frames: Uint8Array[] = [];
  let bytes = 0;
  let finish!: () => void, fail!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  void completed.catch(() => {});
  const abort = () =>
    fail(
      input.signal.reason ?? new DOMException("Speech cancelled", "AbortError"),
    );
  input.signal.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(
    () => fail(Error("Read-aloud deadline exceeded")),
    120000,
  );
  let stream: ReturnType<CartesiaSonicTtsAdapter["createStream"]> | undefined;
  try {
    input.signal.throwIfAborted();
    stream = adapter.createStream(
      {},
      {
        onAudioFrame(event) {
          bytes += event.bytes.length;
          if (bytes > 8 * 1024 * 1024 || event.bytes.length % 2) {
            fail(Error("Invalid read-aloud audio"));
            return;
          }
          frames.push(event.bytes.slice());
        },
        onComplete: finish,
        onProviderError: () => fail(Error("Read-aloud provider failed")),
        onCancelled: () => fail(Error("Read-aloud cancelled")),
      },
    );
    await Promise.race([
      stream.opened,
      completed.then(() => {
        throw Error("Speech ended before dispatch");
      }),
    ]);
    await input.beforeDispatch();
    input.signal.throwIfAborted();
    stream.sendPhrase({ text: input.text, continueContext: false });
    await completed;
    input.signal.throwIfAborted();
    await input.beforeDispatch();
    if (!bytes) throw Error("Empty read-aloud audio");
    const samples = new Float32Array(bytes / 2);
    let at = 0;
    for (const frame of frames) {
      const view = new DataView(
        frame.buffer,
        frame.byteOffset,
        frame.byteLength,
      );
      for (let i = 0; i < frame.length; i += 2) {
        const value = view.getInt16(i, true);
        samples[at++] = value / (value < 0 ? 32768 : 32767);
      }
    }
    return encodePcm16Wav(samples, 16000);
  } finally {
    clearTimeout(deadline);
    input.signal.removeEventListener("abort", abort);
    stream?.cancel("read_aloud_retired");
    adapter.close("read_aloud_retired");
    frames.length = 0;
  }
}
