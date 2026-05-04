import { describe, expect, it, vi } from "vitest";
import { createAndroidNativeAgentTransport } from "./android-native-agent-transport";

describe("createAndroidNativeAgentTransport", () => {
  it("routes Android local agent requests through the native plugin as path-only calls", async () => {
    const request = vi.fn(async () => ({
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    }));
    const transport = createAndroidNativeAgentTransport({ request });

    const response = await transport.request(
      "http://127.0.0.1:31337/api/conversations?limit=1",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token",
        },
        body: JSON.stringify({ title: "Local" }),
      },
    );

    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/conversations?limit=1",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Local" }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
