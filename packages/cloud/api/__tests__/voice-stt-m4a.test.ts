/**
 * Chromium and Safari report .m4a files (voice memos) as audio/x-m4a.
 * The STT route must accept that declared type: its signature allowlist
 * already accepts the detected audio/x-m4a content type.
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

/** Minimal ISO-BMFF ftyp box with the M4A brand, as in a real .m4a file. */
function m4aHead(): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(32));
  const view = new DataView(buf.buffer);
  view.setUint32(0, 32, false); // box size
  buf.set(new TextEncoder().encode("ftyp"), 4);
  buf.set(new TextEncoder().encode("M4A "), 8); // major brand
  view.setUint32(12, 0, false); // minor version
  buf.set(new TextEncoder().encode("M4A "), 16); // compatible brand
  buf.set(new TextEncoder().encode("mp42"), 20);
  buf.set(new TextEncoder().encode("isom"), 24);
  return buf;
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

test("transcribes a .m4a voice memo the browser labels audio/x-m4a", async () => {
  const form = new FormData();
  form.append(
    "audio",
    new File([m4aHead()], "voice.m4a", { type: "audio/x-m4a" }),
  );
  const response = await sttApp.request(
    "http://cloud.test/",
    { method: "POST", body: form },
    { WHISPER_STT_URL: `http://127.0.0.1:${whisper.port}` },
  );
  console.log("STATUS", response.status, "BODY", await response.clone().text());
  console.log("WHISPER_RECEIVED", JSON.stringify(received));
  expect(response.status).toBe(200);
});
