/**
 * Telegram voice notes, Discord voice messages and Firefox recordings are
 * Ogg/Opus. file-type reports them as `audio/ogg; codecs=opus`; the STT route
 * must accept them and forward them to the provider as `audio/ogg`.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import * as generativeRouteAuth from "../src/lib/generative-route-auth";

mock.module("@/api-app/lib/generative-route-auth", () => ({
  ...generativeRouteAuth,
  requireGenerativeRouteCaller: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: null,
    admissionSnapshot: null,
    credential: undefined,
  }),
}));

const { default: sttApp } = await import("../v1/voice/stt/route");

/** First Ogg page of an Opus stream: page header + OpusHead packet. */
function oggOpusHead(): Uint8Array<ArrayBuffer> {
  const page = new Uint8Array(new ArrayBuffer(28 + 19));
  page.set(new TextEncoder().encode("OggS"), 0);
  page[5] = 0x02; // beginning of stream
  page[26] = 1; // one segment
  page[27] = 19; // segment length
  page.set(new TextEncoder().encode("OpusHead"), 28);
  page[36] = 1; // version
  page[37] = 1; // channels
  new DataView(page.buffer).setUint32(40, 48_000, true); // input sample rate
  return page;
}

let whisper: ReturnType<typeof Bun.serve>;
const received: string[] = [];

beforeAll(() => {
  whisper = Bun.serve({
    port: 0,
    async fetch(request) {
      const file = (await request.formData()).get("file") as File;
      received.push(file.type);
      return Response.json({ text: "hello" });
    },
  });
});

afterAll(() => whisper.stop(true));

test("transcribes an Ogg/Opus voice note through the free Whisper path", async () => {
  const form = new FormData();
  form.append(
    "audio",
    new File([oggOpusHead()], "voice.ogg", { type: "audio/ogg" }),
  );
  const response = await sttApp.request(
    "http://cloud.test/",
    { method: "POST", body: form },
    { WHISPER_STT_URL: `http://127.0.0.1:${whisper.port}` },
  );

  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ transcript: "hello" });
  expect(received).toEqual(["audio/ogg"]);
});
