/**
 * Queue and timeout tests for renderer-driven OCR bridge requests.
 */

import { describe, expect, it } from "vitest";
import { OcrBridgeService, type OcrBridgeWord } from "./ocr-bridge.js";

function makeBridge(timeoutMs = 20_000): OcrBridgeService {
  return new OcrBridgeService(undefined, timeoutMs);
}

const SAMPLE_PNG = new Uint8Array([1, 2, 3, 4]);

const WORD: OcrBridgeWord = {
  text: "Save",
  left: 10,
  top: 20,
  width: 40,
  height: 16,
  confidence: 90,
  block: 1,
  par: 1,
  line: 1,
};

describe("OcrBridgeService", () => {
  it("enqueues an OCR request and drains it once", () => {
    const bridge = makeBridge();
    void bridge.requestOcr(SAMPLE_PNG, 11);

    const drained = bridge.takeRequests();
    expect(drained).toHaveLength(1);
    expect(drained[0].imageBase64).toBe(
      Buffer.from(SAMPLE_PNG).toString("base64"),
    );
    expect(drained[0].psm).toBe(11);
    expect(typeof drained[0].requestId).toBe("string");
    expect(typeof drained[0].createdAt).toBe("number");
    expect(bridge.takeRequests()).toHaveLength(0);
  });

  it("submitResult resolves the matching pending promise", async () => {
    const bridge = makeBridge();
    const wordsPromise = bridge.requestOcr(SAMPLE_PNG);
    const [request] = bridge.takeRequests();

    expect(bridge.submitResult(request.requestId, [WORD])).toBe(true);
    expect(await wordsPromise).toEqual([WORD]);
  });

  it("rejects unknown or already-consumed request ids", async () => {
    const bridge = makeBridge();
    const wordsPromise = bridge.requestOcr(SAMPLE_PNG);
    const [request] = bridge.takeRequests();

    expect(bridge.submitResult("missing", [WORD])).toBe(false);
    expect(bridge.submitResult(request.requestId, [WORD])).toBe(true);
    await wordsPromise;
    expect(bridge.submitResult(request.requestId, [WORD])).toBe(false);
  });

  it("failRequest resolves the pending promise as null", async () => {
    const bridge = makeBridge();
    const wordsPromise = bridge.requestOcr(SAMPLE_PNG);
    const [request] = bridge.takeRequests();

    expect(bridge.failRequest(request.requestId, "native_unavailable")).toBe(
      true,
    );
    expect(await wordsPromise).toBeNull();
    expect(bridge.failRequest(request.requestId, "again")).toBe(false);
  });

  it("resolves null when the renderer never responds", async () => {
    const bridge = makeBridge(5);
    await expect(bridge.requestOcr(SAMPLE_PNG)).resolves.toBeNull();
  });

  it("stop clears queued and pending requests", async () => {
    const bridge = makeBridge();
    const first = bridge.requestOcr(SAMPLE_PNG);
    const second = bridge.requestOcr(SAMPLE_PNG);
    void bridge.requestOcr(SAMPLE_PNG);

    await bridge.stop();

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(bridge.takeRequests()).toHaveLength(0);
  });
});
