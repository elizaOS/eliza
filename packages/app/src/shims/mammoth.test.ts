/**
 * Unit tests for the browser `mammoth` DOCX-extraction shim. The suite drives
 * the real module (not a mock) and records that `extractRawText` is the only
 * export and always rejects with the renderer-unavailable Error, including
 * empty calls, extra arguments the Node mammoth API would accept, repeated
 * calls, and concurrent calls. There is no comparator, queue, capacity, or
 * removal API.
 */
import { describe, expect, it } from "vitest";

import * as mammoth from "./mammoth.js";
import { extractRawText } from "./mammoth.js";

const UNAVAILABLE_MESSAGE =
  "DOCX extraction is unavailable in the browser renderer.";

async function expectUnavailable(
  pending: Promise<{ value: string }>,
): Promise<void> {
  await expect(pending).rejects.toMatchObject({
    name: "Error",
    message: UNAVAILABLE_MESSAGE,
  });
}

describe("mammoth shim exports", () => {
  it("exports only extractRawText as a function", () => {
    expect(Object.keys(mammoth).sort()).toEqual(["extractRawText"]);
    expect(typeof mammoth.extractRawText).toBe("function");
    expect(mammoth.extractRawText).toBe(extractRawText);
  });

  it("has no default export on the module namespace", () => {
    expect(Object.hasOwn(mammoth, "default")).toBe(false);
  });
});

describe("extractRawText always rejects", () => {
  it("returns a Promise instead of throwing synchronously", async () => {
    const pending = extractRawText();
    expect(pending).toBeInstanceOf(Promise);
    await expectUnavailable(pending);
  });

  it("rejects an empty call with the renderer-unavailable Error", async () => {
    await expectUnavailable(extractRawText());
  });

  it("rejects extra arguments the Node mammoth API would accept", async () => {
    await expectUnavailable(
      Reflect.apply(extractRawText, undefined, [
        { buffer: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) },
      ]),
    );
    await expectUnavailable(
      Reflect.apply(extractRawText, undefined, [{ path: "/tmp/missing.docx" }]),
    );
    await expectUnavailable(
      Reflect.apply(extractRawText, undefined, [
        { arrayBuffer: new ArrayBuffer(0) },
      ]),
    );
  });

  it("rejects null, undefined, and empty-object payloads the same way", async () => {
    await expectUnavailable(Reflect.apply(extractRawText, undefined, [null]));
    await expectUnavailable(
      Reflect.apply(extractRawText, undefined, [undefined]),
    );
    await expectUnavailable(Reflect.apply(extractRawText, undefined, [{}]));
  });

  it("returns a distinct rejected Promise on each call", async () => {
    const first = extractRawText();
    const second = extractRawText();
    expect(first).not.toBe(second);

    const [a, b] = await Promise.allSettled([first, second]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(a).toMatchObject({
      status: "rejected",
      reason: { name: "Error", message: UNAVAILABLE_MESSAGE },
    });
    expect(b).toMatchObject({
      status: "rejected",
      reason: { name: "Error", message: UNAVAILABLE_MESSAGE },
    });
    if (a.status === "rejected" && b.status === "rejected") {
      expect(a.reason).not.toBe(b.reason);
    }
  });

  it("rejects every concurrent call independently", async () => {
    const settled = await Promise.allSettled([
      extractRawText(),
      extractRawText(),
      extractRawText(),
    ]);
    expect(settled).toHaveLength(3);
    for (const result of settled) {
      expect(result.status).toBe("rejected");
      expect(result).toMatchObject({
        status: "rejected",
        reason: { name: "Error", message: UNAVAILABLE_MESSAGE },
      });
    }
  });
});
