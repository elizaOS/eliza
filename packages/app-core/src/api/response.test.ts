/**
 * Tests the API response sanitizer at the boundary where arbitrary route
 * payloads become client-visible JSON.
 */
import { describe, expect, it } from "vitest";
import { __test__ } from "./response";

describe("sendJson payload sanitization", () => {
  it("removes stack fields from nested payloads", () => {
    const payload = {
      ok: false,
      error: {
        message: "boom",
        stack: "secret stack",
        nested: [{ stackTrace: "secret trace", value: 1 }],
      },
    };

    expect(__test__.sanitizeJsonPayload(payload)).toEqual({
      ok: false,
      error: {
        message: "boom",
        nested: [{ value: 1 }],
      },
    });
  });

  it("serializes Error instances without stack traces", () => {
    expect(__test__.sanitizeJsonPayload(new Error("boom"))).toEqual({
      error: "boom",
    });
  });
});
