/**
 * HTTP route tests for draining OCR bridge requests and accepting native results.
 */

import { describe, expect, it } from "vitest";
import { OcrBridgeService, type OcrBridgeWord } from "./ocr-bridge.js";
import { ocrRequestsRoute, ocrResultRoute } from "./routes.js";

function makeRuntime(bridge: OcrBridgeService | null) {
  return {
    getService: () => bridge,
  };
}

async function callRoute(
  route: typeof ocrRequestsRoute,
  bridge: OcrBridgeService | null,
  body?: unknown,
) {
  return route.routeHandler?.({
    runtime: makeRuntime(bridge),
    body,
  } as never);
}

function parseBody(result: unknown): unknown {
  const body = (result as { body?: string }).body;
  return typeof body === "string" ? JSON.parse(body) : null;
}

const WORD: OcrBridgeWord = {
  text: "Save",
  left: 1,
  top: 2,
  width: 3,
  height: 4,
  confidence: 90,
  block: 1,
  par: 1,
  line: 1,
};

describe("OCR bridge routes", () => {
  it("drains queued OCR requests and accepts recognized words", async () => {
    const bridge = new OcrBridgeService(undefined, 30_000);
    const wordsPromise = bridge.requestOcr(new Uint8Array([1, 2, 3]), 11);

    const getResult = await callRoute(ocrRequestsRoute, bridge);
    const getBody = parseBody(getResult) as {
      requests: Array<{ requestId: string; imageBase64: string; psm?: number }>;
    };
    expect(getBody.requests).toHaveLength(1);
    expect(getBody.requests[0].imageBase64).toBe(
      Buffer.from([1, 2, 3]).toString("base64"),
    );
    expect(getBody.requests[0].psm).toBe(11);

    const postResult = await callRoute(ocrResultRoute, bridge, {
      requestId: getBody.requests[0].requestId,
      words: [WORD, { text: "bad" }],
    });
    expect((postResult as { status: number }).status).toBe(200);
    expect(parseBody(postResult)).toEqual({ ok: true });
    expect(await wordsPromise).toEqual([WORD]);
  });

  it("returns empty queue when the bridge service is unavailable", async () => {
    const result = await callRoute(ocrRequestsRoute, null);
    expect((result as { status: number }).status).toBe(200);
    expect(parseBody(result)).toEqual({ requests: [] });
  });

  it("rejects malformed OCR results", async () => {
    const bridge = new OcrBridgeService(undefined, 30_000);
    const result = await callRoute(ocrResultRoute, bridge, { words: [] });
    expect((result as { status: number }).status).toBe(400);
    expect(parseBody(result)).toEqual({ ok: false, error: "invalid_body" });
  });

  it("settles pending OCR requests on renderer error", async () => {
    const bridge = new OcrBridgeService(undefined, 30_000);
    const wordsPromise = bridge.requestOcr(new Uint8Array([1]));
    const [request] = bridge.takeRequests();

    const result = await callRoute(ocrResultRoute, bridge, {
      requestId: request.requestId,
      error: "native OCR plugin unavailable",
    });

    expect((result as { status: number }).status).toBe(200);
    expect(await wordsPromise).toBeNull();
  });
});
