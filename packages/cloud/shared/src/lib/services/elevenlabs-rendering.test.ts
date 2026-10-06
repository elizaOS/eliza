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

test("timed SDK stream yields provider alignment before the complete audio arrives", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  let transport: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requestUrl = request.url;
    requestBody = (await request.json()) as Record<string, unknown>;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          transport = controller;
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                audio_base64: "AQID",
                alignment: {
                  characters: ["H"],
                  character_start_times_seconds: [0],
                  character_end_times_seconds: [0.2],
                },
              }) + "\n",
            ),
          );
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const service = new ElevenLabsService({ apiKey: "synthetic-test-key" });
    const reader = (
      await service.textToSpeechWithTimestamps({
        text: "Hi.",
        voiceId: "test-voice",
        speed: 0.9,
        applyTextNormalization: "on",
      })
    ).getReader();
    const first = JSON.parse(new TextDecoder().decode((await reader.read()).value));
    expect(requestUrl).toContain("/stream/with-timestamps");
    expect(requestBody).toMatchObject({
      voice_settings: { speed: 0.9 },
      apply_text_normalization: "on",
    });
    expect(first.alignment).toEqual({
      characters: ["H"],
      characterStartTimesSeconds: [0],
      characterEndTimesSeconds: [0.2],
    });
    transport!.enqueue(encoder.encode(JSON.stringify({ audio_base64: "BA==" }) + "\n"));
    transport!.close();
    expect(JSON.parse(new TextDecoder().decode((await reader.read()).value)).sequence).toBe(1);
    expect(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type).toBe("done");
    expect((await reader.read()).done).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("timed synthesis does not retry a failed provider request", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  try {
    const service = new ElevenLabsService({ apiKey: "synthetic-test-key" });
    await expect(service.textToSpeechWithTimestamps({ text: "Hi." })).rejects.toThrow();
    expect(requests).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancelling timed playback aborts the real SDK request signal", async () => {
  const originalFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    request.signal.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true },
    );
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"audio_base64":"AQID"}\n'));
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const service = new ElevenLabsService({ apiKey: "synthetic-test-key" });
    const reader = (await service.textToSpeechWithTimestamps({ text: "Hi." })).getReader();
    await reader.read();
    await reader.cancel();
    expect(aborted).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
