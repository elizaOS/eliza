import { expect, test } from "bun:test";
import { synthesizeCartesiaBytes } from "./cartesia-synthesis";

test("Cartesia REST synthesis uses the same Sonic 3.6 default and preserves voice and MP3 format", async () => {
  const voiceId = "47c38ca4-5f35-497b-b1a3-415245fb35e1";
  let sent: Record<string, unknown> | undefined;
  const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
  const result = await synthesizeCartesiaBytes({
    apiKey: "synthetic-provider-key",
    voiceId,
    text: "Hello.",
    fetch: (async (url, init) => {
      expect(url).toBe("https://api.cartesia.ai/tts/bytes");
      sent = JSON.parse(String(init?.body));
      return new Response(audio, {
        headers: { "Content-Type": "audio/mpeg" },
      });
    }) as typeof fetch,
  });
  expect(sent).toEqual({
    model_id: "sonic-3.6",
    transcript: "Hello.",
    voice: { mode: "id", id: voiceId },
    output_format: {
      container: "mp3",
      sample_rate: 44_100,
      bit_rate: 128_000,
    },
  });
  expect(result.modelId).toBe("sonic-3.6");
  expect(result.provider).toBe("cartesia");
  expect(await new Response(result.body).bytes()).toEqual(audio);
});
