/**
 * PLUGIN configure must fail closed when the save response is not a JSON
 * object. An HTTP 200 carrying a proxy HTML page, an empty body, or a
 * truncated payload previously fell through to `success: true`
 * ("Updated ... config") although the save was never acknowledged.
 * Deterministic; stubs global fetch.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginAction } from "./plugin.ts";

const CONFIGURE_OPTIONS = {
  parameters: {
    action: "configure",
    pluginId: "discord",
    config: { DISCORD_API_TOKEN: "secret" },
  },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function runConfigure() {
  return pluginAction.handler(
    {} as IAgentRuntime,
    { roomId: "room" } as unknown as Memory,
    undefined,
    CONFIGURE_OPTIONS,
    undefined,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PLUGIN configure save acknowledgement", () => {
  it.each([{}, { error: "Save was rejected" }, { ok: "true" }, { success: 1 }])(
    "rejects an object without a boolean save acknowledgement: %j",
    async (body) => {
      const fetchMock = vi.fn(async () => jsonResponse(body));
      vi.stubGlobal("fetch", fetchMock);
      const result = await runConfigure();
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "PLUGIN_CONFIGURE_FAILED" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("fails when a 200 save response is not JSON", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>proxy</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runConfigure();

    expect(result.success).toBe(false);
    expect(result.text).toContain("Failed to save config for discord");
    expect(result.data).toMatchObject({ error: "PLUGIN_CONFIGURE_FAILED" });
    // The unacknowledged save must not proceed to the connection test.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails when a 200 save response is JSON but not an object", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(true));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runConfigure();

    expect(result.success).toBe(false);
    expect(result.text).toContain("Failed to save config for discord");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still reports success for the real save acknowledgement", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/test")) {
          return jsonResponse({ success: true, durationMs: 3 });
        }
        expect(init?.method).toBe("PUT");
        return jsonResponse({ ok: true, requiresRestart: false });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runConfigure();

    expect(result).toMatchObject({ success: true });
    expect(result.text).toContain("Updated discord config");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still fails on an HTTP error status with a JSON body", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "unknown plugin" }, 404),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runConfigure();

    expect(result.success).toBe(false);
    expect(result.text).toContain("Failed to save config for discord");
  });
});
