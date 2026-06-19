/**
 * Tests for `POST /api/tts/first-run/speak`.
 *
 * The route reads `{ lineId }`, validates it against the canonical onboarding
 * line ids, and streams the committed pre-generated OmniVoice preset (WAV):
 *
 *   - 200 + audio/wav bytes when the preset exists
 *   - 400 on an unknown line id (reader never called)
 *   - 404 when the preset has not been generated yet
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

function makeDeps(preset: Buffer | null): {
  deps: FirstRunTtsRouteDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: FirstRunTtsRouteDeps = {
    readPreset: (lineId) => {
      calls.push(lineId);
      return preset;
    },
  };
  return { deps, calls };
}

describe("POST /api/tts/first-run/speak", () => {
  it("streams the committed preset as audio/wav", async () => {
    const audio = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    const { deps, calls } = makeDeps(audio);
    const { req, res, captured } = makeReqRes({ lineId: "runtime" });

    const handled = await handleFirstRunTtsRoute(req, res, deps);

    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.headers["content-type"]).toBe("audio/wav");
    expect(captured.headers["cache-control"]).toBe("no-store");
    expect(captured.headers["content-length"]).toBe(String(audio.byteLength));
    expect(captured.body).toEqual(audio);
    expect(calls).toEqual(["runtime"]);
  });

  it("returns 400 on an unknown line id without reading a preset", async () => {
    const { deps, calls } = makeDeps(Buffer.from([0x00]));
    const { req, res, captured } = makeReqRes({ lineId: "../../etc/passwd" });

    const handled = await handleFirstRunTtsRoute(req, res, deps);

    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("returns 404 when the preset has not been generated yet", async () => {
    const { deps, calls } = makeDeps(null);
    const { req, res, captured } = makeReqRes({ lineId: "remote" });

    const handled = await handleFirstRunTtsRoute(req, res, deps);

    expect(handled).toBe(true);
    expect(captured.status).toBe(404);
    expect(calls).toEqual(["remote"]);
  });
});
