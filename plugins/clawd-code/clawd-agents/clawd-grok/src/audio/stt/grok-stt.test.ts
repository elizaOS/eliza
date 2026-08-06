import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSttEngine, inferMimeTypeFromFileName } from "./grok-stt";

describe("GrokSttEngine", () => {
  let tempDir: string;
  const originalFetch = global.fetch;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-stt-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("requires an API key", () => {
    expect(() => new GrokSttEngine({ apiKey: "" })).toThrow(/API key/i);
    expect(() => new GrokSttEngine({ apiKey: "   " })).toThrow(/API key/i);
  });

  it("posts the audio file as multipart form-data to /v1/stt", async () => {
    const audioPath = path.join(tempDir, "voice.ogg");
    fs.writeFileSync(audioPath, "audio-bytes");

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          text: "hello world",
          language: "en",
          duration: 1.23,
          words: [{ text: "hello", start: 0, end: 0.5 }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const engine = new GrokSttEngine({
      apiKey: "test-key",
      baseURL: "https://api.x.ai/v1/",
      language: "en",
    });

    const result = await engine.transcribe({ audioPath, fileName: "voice.ogg" });

    expect(result).toEqual({
      text: "hello world",
      engine: "grok-stt",
      language: "en",
      duration: 1.23,
      words: [{ text: "hello", start: 0, end: 0.5 }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.x.ai/v1/stt");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");

    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("language")).toBe("en");
    expect(body.get("format")).toBe("true");
    const file = body.get("file") as Blob | null;
    expect(file).not.toBeNull();
    expect(file).toBeInstanceOf(Blob);
    expect(await (file as Blob).text()).toBe("audio-bytes");
  });

  it("omits language and format fields when language is not provided", async () => {
    const audioPath = path.join(tempDir, "clip.mp3");
    fs.writeFileSync(audioPath, "mp3-bytes");

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "ok", duration: 0.5 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const engine = new GrokSttEngine({ apiKey: "test-key" });
    await engine.transcribe({ audioPath });

    const body = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(body.get("language")).toBeNull();
    expect(body.get("format")).toBeNull();
  });

  it("surfaces non-2xx responses with status and body", async () => {
    const audioPath = path.join(tempDir, "clip.mp3");
    fs.writeFileSync(audioPath, "mp3-bytes");

    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("invalid audio", { status: 400, statusText: "Bad Request" }),
      ) as unknown as typeof fetch;

    const engine = new GrokSttEngine({ apiKey: "test-key" });
    await expect(engine.transcribe({ audioPath })).rejects.toThrow(/Grok STT request failed \(400\).*invalid audio/);
  });

  it("rejects empty transcripts", async () => {
    const audioPath = path.join(tempDir, "clip.mp3");
    fs.writeFileSync(audioPath, "mp3-bytes");

    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "   ", duration: 0.1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const engine = new GrokSttEngine({ apiKey: "test-key" });
    await expect(engine.transcribe({ audioPath })).rejects.toThrow(/empty transcript/i);
  });
});

describe("inferMimeTypeFromFileName", () => {
  it("maps common audio extensions to mime types", () => {
    expect(inferMimeTypeFromFileName("voice.ogg")).toBe("audio/ogg");
    expect(inferMimeTypeFromFileName("clip.mp3")).toBe("audio/mpeg");
    expect(inferMimeTypeFromFileName("clip.wav")).toBe("audio/wav");
    expect(inferMimeTypeFromFileName("clip.opus")).toBe("audio/opus");
    expect(inferMimeTypeFromFileName("clip.m4a")).toBe("audio/mp4");
    expect(inferMimeTypeFromFileName("clip.unknown")).toBe("application/octet-stream");
  });
});
