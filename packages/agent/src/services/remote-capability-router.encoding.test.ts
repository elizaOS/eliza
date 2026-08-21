/** Exercises malformed request input with deterministic route collaborators. */

import { UnavailableCapabilityRouter } from "@elizaos/core";
import { describe, expect, test, vi } from "vitest";
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

  test("passes the decoded module id and asset path to the router", async () => {
    const router = new UnavailableCapabilityRouter("server");
    const getAsset = vi.fn(async () => ({
      path: "/views/demo.js",
      contentType: "text/javascript",
      bodyBase64: Buffer.from("asset bytes").toString("base64"),
    }));
    router.plugin.getAsset = getAsset;
    const handler = createRemoteCapabilityFetchHandler(router);
    const response = await handler(
      new Request(
        "https://device.test/v1/capabilities/assets/%64emo-plugin/views/demo.js",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset bytes");
    expect(getAsset).toHaveBeenCalledWith({
      moduleId: "demo-plugin",
      path: "/views/demo.js",
    });
  });
});
