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

  it("treats an explicitly empty byte payload as authoritative", async () => {
    const response = nativeHttpResultToResponse({
      status: 200,
      body: "stale text",
      bodyBase64: "",
    });
    expect((await response.arrayBuffer()).byteLength).toBe(0);
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
    expect(
      await nativeHttpResultToResponse({ status: 205, body: "ignored" }).text(),
    ).toBe("");
  });

  it("preserves status text and repeated response headers", () => {
    const response = nativeHttpResultToResponse({
      status: 206,
      statusText: "Partial Content",
      headers: [
        ["set-cookie", "first=1"],
        ["set-cookie", "second=2"],
        ["x-native-transport", "test"],
      ],
      bodyBase64: "AQI=",
    });
    expect(response.status).toBe(206);
    expect(response.statusText).toBe("Partial Content");
    expect(response.headers.get("x-native-transport")).toBe("test");
    expect(response.headers.getSetCookie()).toEqual(["first=1", "second=2"]);
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
