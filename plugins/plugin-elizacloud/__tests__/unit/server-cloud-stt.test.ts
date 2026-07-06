/**
 * Agent-side cloud STT proxy (`POST /api/asr/cloud`). Verifies the WAV → cloud
 * `/voice/stt` multipart forward and the fail-loud contract (401 with no cloud
 * key, 502 on an unreachable upstream) using a fake req/res and a stubbed
 * global `fetch` — no live cloud service.
 */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCloudSttRoute } from "../../src/lib/server-cloud-tts";

function fakeRequest(body: Buffer, contentType = "audio/wav") {
  const stream = new PassThrough();
  stream.end(body);
  return Object.assign(stream, {
    headers: { "content-type": contentType },
  }) as unknown as import("node:http").IncomingMessage;
}

function fakeResponse() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    headersSent: false,
    body: "",
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk;
      res.headersSent = true;
    },
    headers,
  };
  return res as unknown as import("node:http").ServerResponse & {
    body: string;
    statusCode: number;
  };
}

describe("handleCloudSttRoute", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.ELIZAOS_CLOUD_API_KEY = "test-cloud-key";
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    fetchSpy.mockRestore();
  });

  it("forwards the WAV to the cloud /voice/stt route as multipart and returns { text }", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ text: "  transcribed  " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const wav = Buffer.from([82, 73, 70, 70, 1, 2, 3]); // "RIFF"..
    const req = fakeRequest(wav);
    const res = fakeResponse();

    const handled = await handleCloudSttRoute(req, res);

    expect(handled).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/voice\/stt$/);
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-cloud-key");
    // Multipart body: a FormData carrying the `audio` field.
    const form = (init as RequestInit).body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const audio = form.get("audio");
    expect(audio).toBeInstanceOf(Blob);
    expect((audio as Blob).size).toBe(wav.length);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ text: "transcribed" });
  });

  it("returns 401 when Eliza Cloud is not connected (no api key)", async () => {
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    // Point config resolution at a path that does not exist so a real
    // ~/.local/state config with a cloud key on the dev box can't leak in.
    process.env.ELIZA_CONFIG_PATH = "/nonexistent/eliza-stt-test-no-key.json";
    const res = fakeResponse();

    await handleCloudSttRoute(fakeRequest(Buffer.from([1])), res);

    delete process.env.ELIZA_CONFIG_PATH;
    expect(res.statusCode).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty audio body", async () => {
    const res = fakeResponse();
    await handleCloudSttRoute(fakeRequest(Buffer.alloc(0)), res);
    expect(res.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails loud with 502 when the upstream is unreachable", async () => {
    fetchSpy.mockResolvedValue(new Response("upstream down", { status: 503 }));
    const res = fakeResponse();

    await handleCloudSttRoute(fakeRequest(Buffer.from([1, 2])), res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatch(/Eliza Cloud STT failed/);
  });
});
