import { expect, test } from "bun:test";
import { ElevenLabsService } from "./elevenlabs";

test("real SDK serializes rendering controls and preserves the audio stream", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, body: (await request.json()) as Record<string, unknown> });
    return new Response(new Uint8Array([73, 68, 51, 1]), {
      headers: { "Content-Type": "audio/mpeg" },
    });
  }) as typeof fetch;
  try {
    const service = new ElevenLabsService({
      apiKey: "synthetic-test-key",
      optimizeStreamingLatency: 4,
    });
    const audio = await service.textToSpeech({
      text: "Your total is $12.50.",
      voiceId: "test-voice",
      speed: 0.8,
      previousText: "Here is the bill.",
      nextText: "Check the amount.",
      applyTextNormalization: "on",
    });
    expect(new Uint8Array(await new Response(audio).arrayBuffer())).toEqual(
      new Uint8Array([73, 68, 51, 1]),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      text: "Your total is $12.50.",
      previous_text: "Here is the bill.",
      next_text: "Check the amount.",
      apply_text_normalization: "on",
      voice_settings: { speed: 0.8 },
    });
    expect(new URL(requests[0]!.url).searchParams.has("optimize_streaming_latency")).toBe(false);
    const legacy = await service.textToSpeech({ text: "Hello.", voiceId: "test-voice" });
    await new Response(legacy).arrayBuffer();
    expect(new URL(requests[1]!.url).searchParams.get("optimize_streaming_latency")).toBe("4");
    expect(requests[1]?.body.apply_text_normalization).toBeNull();
    await expect(service.textToSpeech({ text: "Hello.", speed: 5 })).rejects.toThrow();
    expect(requests).toHaveLength(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
