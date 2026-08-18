/**
 * GET /v1/capabilities/assets/:moduleId/... decoded moduleId with
 * decodeURIComponent. A malformed percent-escape threw URIError into the
 * fetch-handler catch, which maps unknown errors to HTTP 500.
 */
import { describe, expect, test } from "bun:test";
import { UnavailableCapabilityRouter } from "@elizaos/core";
import { createRemoteCapabilityFetchHandler } from "./remote-capability-router.ts";

describe("remote capability asset path encoding", () => {
  test("returns 400 instead of 500 for a malformed module id", async () => {
    const handler = createRemoteCapabilityFetchHandler(
      new UnavailableCapabilityRouter("server"),
    );
    const response = await handler(
      new Request(
        "https://device.test/v1/capabilities/assets/%ZZ/views/demo.js",
      ),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CAPABILITY_DECODE_FAILED",
      },
    });
  });

  test("canonical encoded module id still reaches getAsset", async () => {
    const handler = createRemoteCapabilityFetchHandler(
      new UnavailableCapabilityRouter("server"),
    );
    const response = await handler(
      new Request(
        "https://device.test/v1/capabilities/assets/demo-plugin/views/demo.js",
      ),
    );
    // Unavailable router rejects the asset call as a capability error (not 400).
    expect(response.status).not.toBe(400);
    expect([200, 404, 500]).toContain(response.status);
  });
});
