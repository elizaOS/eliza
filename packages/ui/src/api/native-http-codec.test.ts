/** Exercises the native HTTP codec with binary, text, and bodyless responses. */

import { describe, expect, it } from "vitest";
import {
  classifyNativeFetchRequest,
  nativeHttpResultToResponse,
} from "./native-http-codec";

describe("native HTTP codec", () => {
  it("round-trips raw bytes including NUL and non-UTF8 values", async () => {
    const response = nativeHttpResultToResponse({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      bodyBase64: "AP+AQQ==",
    });
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      0, 255, 128, 65,
    ]);
  });

  it("preserves text and suppresses forbidden bodies", async () => {
    expect(
      await nativeHttpResultToResponse({ status: 401, body: "denied" }).text(),
    ).toBe("denied");
    expect(
      await nativeHttpResultToResponse({ status: 204, body: "ignored" }).text(),
    ).toBe("");
    expect(
      await nativeHttpResultToResponse({
        status: 304,
        bodyBase64: "YQ==",
      }).text(),
    ).toBe("");
  });

  it("classifies relative API, absolute, and invalid fetch targets", () => {
    expect(classifyNativeFetchRequest("/api/status")).toEqual({
      kind: "relative-api",
      path: "/api/status",
    });
    expect(classifyNativeFetchRequest("https://api.eliza.app/v1").kind).toBe(
      "absolute",
    );
    expect(classifyNativeFetchRequest("not a url")).toEqual({
      kind: "invalid",
    });
  });
});
