/**
 * Self-call actions must reach the API on the port the server actually binds.
 * The desktop launcher sets ELIZA_API_PORT (31337) and ELIZA_UI_PORT (2138)
 * without ELIZA_PORT; the server binds 31337, so LOGS/RUNTIME/PLUGIN/TERMINAL
 * self-calls must not fall back to the single-process default 2138.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { resolveSelfApiBaseUrl } from "@elizaos/core/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logsAction } from "./logs.ts";

const PORT_KEYS = [
  "ELIZA_API_PORT",
  "ELIZA_PORT",
  "ELIZA_UI_PORT",
  "ELIZA_API_BIND",
] as const;

describe("self-API base URL", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of PORT_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PORT_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.unstubAllGlobals();
  });

  it("follows the server bind precedence", () => {
    expect(resolveSelfApiBaseUrl({})).toBe("http://127.0.0.1:2138");
    expect(resolveSelfApiBaseUrl({ ELIZA_PORT: "4000" })).toBe(
      "http://127.0.0.1:4000",
    );
    expect(
      resolveSelfApiBaseUrl({
        ELIZA_API_PORT: "31337",
        ELIZA_UI_PORT: "2138",
      }),
    ).toBe("http://127.0.0.1:31337");
    expect(
      resolveSelfApiBaseUrl({ ELIZA_API_PORT: "31337", ELIZA_API_BIND: "::1" }),
    ).toBe("http://[::1]:31337");
    expect(
      resolveSelfApiBaseUrl({
        ELIZA_API_PORT: "31337",
        ELIZA_API_BIND: "0.0.0.0",
      }),
    ).toBe("http://127.0.0.1:31337");
    expect(
      resolveSelfApiBaseUrl({
        ELIZA_API_PORT: "31337",
        ELIZA_API_BIND: "10.0.0.5",
      }),
    ).toBe("http://10.0.0.5:31337");
  });

  it.each([
    ["127.0.0.2", "http://127.0.0.2:31337"],
    ["::ffff:127.0.0.2", "http://[::ffff:127.0.0.2]:31337"],
    ["0:0:0:0:0:0:0:1", "http://[0:0:0:0:0:0:0:1]:31337"],
  ])("preserves the specific bound loopback interface %s", (bind, expected) => {
    expect(
      resolveSelfApiBaseUrl({
        ELIZA_API_PORT: "31337",
        ELIZA_API_BIND: bind,
      }),
    ).toBe(expected);
  });

  it("LOGS search calls the desktop API port, not 2138", async () => {
    process.env.ELIZA_API_PORT = "31337";
    process.env.ELIZA_UI_PORT = "2138";
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ entries: [], sources: [], tags: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await logsAction.handler(
      {} as IAgentRuntime,
      { roomId: "room" } as unknown as Memory,
      undefined,
      { parameters: { action: "search" } },
      undefined,
    );

    expect(result).toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url.startsWith("http://127.0.0.1:31337/api/logs")).toBe(true);
  });
});
