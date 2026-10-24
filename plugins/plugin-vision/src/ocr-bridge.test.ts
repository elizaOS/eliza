/**
 * Pure correlation tests for the renderer-pulled OCR bridge.
 *
 * These cover the request, queue, and result handshake without a device or
 * Capacitor host.
 */

import { describe, expect, it } from "vitest";
import { OcrBridgeService } from "./ocr-bridge.js";

function makeBridge(timeoutMs = 30_000): OcrBridgeService {
  // The base Service constructor only stashes runtime; undefined is fine for
  // these pure tests, which never touch it.
  return new OcrBridgeService(undefined, timeoutMs);
}

describe("OcrBridgeService", () => {
  it("enqueues a request via requestOcr and drains it via takeRequests", () => {
    const bridge = makeBridge();
    void bridge.requestOcr(new Uint8Array([1, 2, 3]));
    const drained = bridge.takeRequests();
    expect(drained).toHaveLength(1);
    expect(drained[0].imageBase64).toBe(
      Buffer.from([1, 2, 3]).toString("base64"),
    );
    // Second drain is empty — the queue was consumed.
    expect(bridge.takeRequests()).toHaveLength(0);
  });
  it("drops a timed-out request from the queue the renderer drains", async () => {
    const bridge = makeBridge(5);
    const words = await bridge.requestOcr(new Uint8Array([1]));
    expect(words).toBeNull();
    // A request that timed out can never be delivered, so the poller must not
    // receive it: the renderer would otherwise run on-device OCR on a stale
    // frame for a request the agent already abandoned, then POST words the
    // route rejects as `unknown_request`.
    expect(bridge.takeRequests()).toHaveLength(0);
  });
  it("submitResult resolves the matching pending promise with the words", async () => {
    const bridge = makeBridge();
    const wordsPromise = bridge.requestOcr(new Uint8Array([1]));
    const [request] = bridge.takeRequests();
    const word = {
      text: "Save",
      left: 1,
      top: 2,
      width: 3,
      height: 4,
      confidence: 0.9,
      block: 0,
      par: 0,
      line: 0,
    };
    expect(bridge.submitResult(request.requestId, [word])).toBe(true);
    expect(await wordsPromise).toEqual([word]);
    // Already consumed.
    expect(bridge.submitResult(request.requestId, [word])).toBe(false);
  });
});
