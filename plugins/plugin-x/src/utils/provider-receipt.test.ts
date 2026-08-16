/** Deterministic coverage for accepted X write response shapes and invalid identifiers. */
import { describe, expect, it, vi } from "vitest";
import {
  extractXWriteReceiptId,
  normalizeXReceiptId,
} from "./provider-receipt";

describe("X write receipt extraction", () => {
  it.each([
    [{ id: " direct " }, "direct"],
    [{ data: { id: "nested" } }, "nested"],
    [{ data: { data: { id: "deep" } } }, "deep"],
    [{ rest_id: "rest" }, "rest"],
    [
      {
        data: {
          create_tweet: { tweet_results: { result: { rest_id: "graph" } } },
        },
      },
      "graph",
    ],
  ])("extracts a non-empty id from %o", async (response, expected) => {
    await expect(extractXWriteReceiptId(response)).resolves.toBe(expected);
  });

  it("reads a cloned response body without consuming the original", async () => {
    const originalJson = vi.fn();
    const cloneJson = vi.fn(async () => ({ data: { id: "from-body" } }));
    const response = {
      bodyUsed: false,
      json: originalJson,
      clone: vi.fn(() => ({ json: cloneJson })),
    };

    await expect(extractXWriteReceiptId(response)).resolves.toBe("from-body");
    expect(response.clone).toHaveBeenCalledOnce();
    expect(cloneJson).toHaveBeenCalledOnce();
    expect(originalJson).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "", "   ", 123])(
    "rejects unusable id %o",
    (value) => {
      expect(normalizeXReceiptId(value)).toBeUndefined();
    },
  );

  it("returns an explicit missing receipt for an unreadable body", async () => {
    await expect(
      extractXWriteReceiptId({
        json: vi.fn(async () => {
          throw new Error("malformed body");
        }),
      }),
    ).resolves.toBeUndefined();
  });
});
