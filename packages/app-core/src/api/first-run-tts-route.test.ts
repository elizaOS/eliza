/**
 * Tests for `POST /api/tts/first-run/speak`.
 *
 * The route reads `{ text, voice? }`, delegates synthesis to an injected
 * dependency (edge-tts in production), and streams `audio/mpeg`. Here we cover
 * the route-layer behaviour without touching the network or the plugin:
 *
 *   - 200 + audio bytes on success (voice forwarded)
 *   - 400 on missing/blank text (synthesizer never called)
 *   - 502 when synthesis throws
 */
import { describe, expect, it } from "vitest";

import {
  type FirstRunTtsRouteDeps,
  handleFirstRunTtsRoute,
} from "./first-run-tts-route";

interface CapturedResponse {
  status?: number;
  headers: Record<string, string>;
  body?: string | Buffer;
}

function makeReqRes(body: unknown): {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  captured: CapturedResponse;
} {
  const req = {
    method: "POST",
    body,
  } as unknown as import("node:http").IncomingMessage;
  const captured: CapturedResponse = { headers: {} };
  const res = {
    statusCode: 200,
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) {
        for (const [name, value] of Object.entries(headers)) {
          captured.headers[name.toLowerCase()] = value;
        }
      }
      return res;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(payload?: string | Buffer) {
      if (payload !== undefined) captured.body = payload;
      captured.status ??= res.statusCode;
    },
  } as unknown as import("node:http").ServerResponse & { statusCode: number };
  return { req, res, captured };
}

function makeDeps(overrides: { audio?: Buffer; error?: Error } = {}): {
  deps: FirstRunTtsRouteDeps;
  calls: Array<{ text: string; voice?: string }>;
} {
  const calls: Array<{ text: string; voice?: string }> = [];
  const deps: FirstRunTtsRouteDeps = {
    synthesize: async (text, voice) => {
      calls.push({ text, voice });
      if (overrides.error) throw overrides.error;
      return overrides.audio ?? Buffer.from([0xff, 0xfb, 0x00]);
    },
  };
  return { deps, calls };
}

describe("POST /api/tts/first-run/speak", () => {
  it("streams audio/mpeg on success and forwards the voice", async () => {
    const audio = Buffer.from([0xff, 0xfb, 0x10, 0x20]);
    const { deps, calls } = makeDeps({ audio });
    const { req, res, captured } = makeReqRes({
      text: "  Where should Eliza run?  ",
      voice: "en-US-AriaNeural",
    });

    const handled = await handleFirstRunTtsRoute(req, res, deps);

    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.headers["content-type"]).toBe("audio/mpeg");
    expect(captured.headers["cache-control"]).toBe("no-store");
    expect(captured.headers["content-length"]).toBe(String(audio.byteLength));
    expect(captured.body).toEqual(audio);
    expect(calls).toEqual([
      { text: "Where should Eliza run?", voice: "en-US-AriaNeural" },
    ]);
  });

  it("returns 400 on blank text without calling the synthesizer", async () => {
    const { deps, calls } = makeDeps();
    const { req, res, captured } = makeReqRes({ text: "   " });

    const handled = await handleFirstRunTtsRoute(req, res, deps);

    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("returns 502 when synthesis fails", async () => {
    const { deps } = makeDeps({ error: new Error("network down") });
    const { req, res, captured } = makeReqRes({ text: "hello" });

    const handled = await handleFirstRunTtsRoute(req, res, deps);

    expect(handled).toBe(true);
    expect(captured.status).toBe(502);
    expect(JSON.parse(String(captured.body))).toMatchObject({
      error: expect.stringContaining("network down"),
    });
  });
});
