/**
 * Unit tests for the browser `unpdf` PDF-extraction shim. The suite drives
 * the real module (not a mock) and records that `extractText` and
 * `getDocumentProxy` are the only exports and always reject with their
 * renderer-unavailable Errors, including empty calls, extra arguments the
 * Node unpdf API would accept, repeated calls, and concurrent calls. There
 * is no comparator, queue, capacity, or removal API.
 */
import { describe, expect, it } from "vitest";

import * as unpdf from "./unpdf.js";
import { extractText, getDocumentProxy } from "./unpdf.js";

const EXTRACT_UNAVAILABLE =
  "PDF text extraction is unavailable in the browser renderer.";
const PROXY_UNAVAILABLE =
  "PDF document proxy is unavailable in the browser renderer.";

async function expectExtractUnavailable(
  pending: Promise<{ text: string }>,
): Promise<void> {
  await expect(pending).rejects.toMatchObject({
    name: "Error",
    message: EXTRACT_UNAVAILABLE,
  });
}

async function expectProxyUnavailable(pending: Promise<never>): Promise<void> {
  await expect(pending).rejects.toMatchObject({
    name: "Error",
    message: PROXY_UNAVAILABLE,
  });
}

describe("unpdf shim exports", () => {
  it("exports only extractText and getDocumentProxy as functions", () => {
    expect(Object.keys(unpdf).sort()).toEqual([
      "extractText",
      "getDocumentProxy",
    ]);
    expect(typeof unpdf.extractText).toBe("function");
    expect(typeof unpdf.getDocumentProxy).toBe("function");
    expect(unpdf.extractText).toBe(extractText);
    expect(unpdf.getDocumentProxy).toBe(getDocumentProxy);
  });

  it("has no default export on the module namespace", () => {
    expect(Object.hasOwn(unpdf, "default")).toBe(false);
  });

  it("reads a missing export as undefined rather than throwing", () => {
    const view = unpdf as Record<string, unknown>;
    expect(view.phonemize).toBeUndefined();
    expect(view.parsePdf).toBeUndefined();
    expect(view[""]).toBeUndefined();
  });
});

describe("extractText always rejects", () => {
  it("returns a Promise instead of throwing synchronously", async () => {
    const pending = extractText();
    expect(pending).toBeInstanceOf(Promise);
    await expectExtractUnavailable(pending);
  });

  it("rejects an empty call with the renderer-unavailable Error", async () => {
    await expectExtractUnavailable(extractText());
  });

  it("rejects extra arguments the Node unpdf API would accept", async () => {
    await expectExtractUnavailable(
      Reflect.apply(extractText, undefined, [
        new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      ]),
    );
    await expectExtractUnavailable(
      Reflect.apply(extractText, undefined, [new ArrayBuffer(0)]),
    );
    await expectExtractUnavailable(
      Reflect.apply(extractText, undefined, [
        { data: new Uint8Array(0) },
        { mergePages: true },
      ]),
    );
  });

  it("rejects null, undefined, and empty-object payloads the same way", async () => {
    await expectExtractUnavailable(
      Reflect.apply(extractText, undefined, [null]),
    );
    await expectExtractUnavailable(
      Reflect.apply(extractText, undefined, [undefined]),
    );
    await expectExtractUnavailable(Reflect.apply(extractText, undefined, [{}]));
  });

  it("returns a distinct rejected Promise on each call", async () => {
    const first = extractText();
    const second = extractText();
    expect(first).not.toBe(second);

    const [a, b] = await Promise.allSettled([first, second]);
    expect(a).toMatchObject({
      status: "rejected",
      reason: { name: "Error", message: EXTRACT_UNAVAILABLE },
    });
    expect(b).toMatchObject({
      status: "rejected",
      reason: { name: "Error", message: EXTRACT_UNAVAILABLE },
    });
    if (a.status === "rejected" && b.status === "rejected") {
      expect(a.reason).not.toBe(b.reason);
    }
  });

  it("rejects every concurrent call independently", async () => {
    const settled = await Promise.allSettled([
      extractText(),
      extractText(),
      extractText(),
    ]);
    expect(settled).toHaveLength(3);
    for (const result of settled) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: { name: "Error", message: EXTRACT_UNAVAILABLE },
      });
    }
  });
});

describe("getDocumentProxy always rejects", () => {
  it("returns a Promise instead of throwing synchronously", async () => {
    const pending = getDocumentProxy();
    expect(pending).toBeInstanceOf(Promise);
    await expectProxyUnavailable(pending);
  });

  it("rejects an empty call with the renderer-unavailable Error", async () => {
    await expectProxyUnavailable(getDocumentProxy());
  });

  it("rejects extra arguments the Node unpdf API would accept", async () => {
    await expectProxyUnavailable(
      Reflect.apply(getDocumentProxy, undefined, [
        new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      ]),
    );
    await expectProxyUnavailable(
      Reflect.apply(getDocumentProxy, undefined, [new ArrayBuffer(8)]),
    );
    await expectProxyUnavailable(
      Reflect.apply(getDocumentProxy, undefined, [{ data: new Uint8Array(0) }]),
    );
  });

  it("rejects null, undefined, and empty-object payloads the same way", async () => {
    await expectProxyUnavailable(
      Reflect.apply(getDocumentProxy, undefined, [null]),
    );
    await expectProxyUnavailable(
      Reflect.apply(getDocumentProxy, undefined, [undefined]),
    );
    await expectProxyUnavailable(
      Reflect.apply(getDocumentProxy, undefined, [{}]),
    );
  });

  it("returns a distinct rejected Promise on each call", async () => {
    const first = getDocumentProxy();
    const second = getDocumentProxy();
    expect(first).not.toBe(second);

    const [a, b] = await Promise.allSettled([first, second]);
    expect(a).toMatchObject({
      status: "rejected",
      reason: { name: "Error", message: PROXY_UNAVAILABLE },
    });
    expect(b).toMatchObject({
      status: "rejected",
      reason: { name: "Error", message: PROXY_UNAVAILABLE },
    });
    if (a.status === "rejected" && b.status === "rejected") {
      expect(a.reason).not.toBe(b.reason);
    }
  });

  it("rejects every concurrent call independently", async () => {
    const settled = await Promise.allSettled([
      getDocumentProxy(),
      getDocumentProxy(),
      getDocumentProxy(),
    ]);
    expect(settled).toHaveLength(3);
    for (const result of settled) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: { name: "Error", message: PROXY_UNAVAILABLE },
      });
    }
  });
});

describe("extractText and getDocumentProxy stay independent", () => {
  it("uses a distinct unavailable message for each export", async () => {
    expect(EXTRACT_UNAVAILABLE).not.toBe(PROXY_UNAVAILABLE);

    const [extracted, proxied] = await Promise.allSettled([
      extractText(),
      getDocumentProxy(),
    ]);
    expect(extracted).toMatchObject({
      status: "rejected",
      reason: { name: "Error", message: EXTRACT_UNAVAILABLE },
    });
    expect(proxied).toMatchObject({
      status: "rejected",
      reason: { name: "Error", message: PROXY_UNAVAILABLE },
    });
  });

  it("rejects mixed concurrent calls without one export winning a tie", async () => {
    const settled = await Promise.allSettled([
      extractText(),
      getDocumentProxy(),
      extractText(),
      getDocumentProxy(),
    ]);
    expect(settled.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(settled[0]).toMatchObject({
      reason: { message: EXTRACT_UNAVAILABLE },
    });
    expect(settled[1]).toMatchObject({
      reason: { message: PROXY_UNAVAILABLE },
    });
    expect(settled[2]).toMatchObject({
      reason: { message: EXTRACT_UNAVAILABLE },
    });
    expect(settled[3]).toMatchObject({
      reason: { message: PROXY_UNAVAILABLE },
    });
  });

  it("keeps the same namespace on dynamic import as on the static binding", async () => {
    const dynamic = await import("./unpdf.js");
    expect(dynamic).toBe(unpdf);
    expect(dynamic.extractText).toBe(extractText);
    expect(dynamic.getDocumentProxy).toBe(getDocumentProxy);
  });
});
