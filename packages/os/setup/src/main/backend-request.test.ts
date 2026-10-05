// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createBackendRequest } from "./backend-request";

const backend = "http://127.0.0.1:3743";

describe("local backend proxy requests", () => {
  it.each([
    ["/api", "/"],
    ["/api/devices?all=true", "/devices?all=true"],
    [
      "/api//example.invalid/path?probe=true",
      "//example.invalid/path?probe=true",
    ],
    ["/api/%2f%2fexample.invalid", "/%2f%2fexample.invalid"],
  ])("keeps %s on the configured backend", (input, expectedPath) => {
    const forwarded = createBackendRequest(
      new Request(`http://127.0.0.1:5175${input}`),
      backend,
    );
    const url = new URL(forwarded.url);
    expect(url.origin).toBe(backend);
    expect(`${url.pathname}${url.search}`).toBe(expectedPath);
    expect(forwarded.redirect).toBe("error");
  });

  it("preserves method, credentials, body and cancellation", async () => {
    const controller = new AbortController();
    const request = new Request("http://127.0.0.1:5175/api/flash", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ planToken: "test-plan" }),
      signal: controller.signal,
    });
    const forwarded = createBackendRequest(request, backend);
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("Authorization")).toBe("Bearer test-token");
    expect(forwarded.headers.get("Content-Type")).toBe("application/json");
    expect(await forwarded.json()).toEqual({ planToken: "test-plan" });
    controller.abort();
    expect(forwarded.signal.aborted).toBe(true);
  });

  it("rejects requests outside the API prefix", () => {
    expect(() =>
      createBackendRequest(
        new Request("http://127.0.0.1:5175/assets/main.js"),
        backend,
      ),
    ).toThrow(TypeError);
  });
});
