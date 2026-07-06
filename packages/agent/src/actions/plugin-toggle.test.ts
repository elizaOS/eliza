/**
 * Regression test for the `PLUGIN action=toggle` verb.
 *
 * The Plugins view enables/disables a plugin via `client.updatePlugin(id,
 * { enabled })` → `PUT /api/plugins/:id`. This asserts the agent's semantic
 * `PLUGIN` action drives the SAME endpoint and body, so a chat/voice user's
 * "turn on the calendar plugin" hits one shared use case rather than the
 * synthetic-DOM bridge. `fetch` is stubbed to capture the outbound request.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { pluginAction } from "./plugin.ts";

interface CapturedRequest {
  url: string;
  method?: string;
  body: unknown;
}

function stubFetch(response: Record<string, unknown>): {
  captured: CapturedRequest[];
  restore: () => void;
} {
  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    captured.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return {
      ok: true,
      status: 200,
      json: async () => response,
    } as Response;
  }) as typeof fetch;
  return {
    captured,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const runtime = { agentId: "agent-1" } as unknown as IAgentRuntime;

async function invokeToggle(pluginId: string, enabled: boolean) {
  return pluginAction.handler(
    runtime,
    { content: { text: "" } } as never,
    undefined,
    { parameters: { action: "toggle", pluginId, enabled } },
    undefined,
  );
}

describe("PLUGIN action=toggle → PUT /api/plugins/:id", () => {
  let restoreFetch: (() => void) | null = null;

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  it("issues PUT /api/plugins/:id with { enabled: true } to the same use case the UI calls", async () => {
    const { captured, restore } = stubFetch({ success: true });
    restoreFetch = restore;

    const result = await invokeToggle("discord", true);

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("PUT");
    expect(captured[0].url).toMatch(/\/api\/plugins\/discord$/);
    expect(captured[0].body).toEqual({ enabled: true });
    expect(result).toBeDefined();
    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({ op: "toggle", enabled: true });
  });

  it("encodes a scoped plugin id and forwards { enabled: false } on disable", async () => {
    const { captured, restore } = stubFetch({ success: true });
    restoreFetch = restore;

    await invokeToggle("@elizaos/plugin-calendar", false);

    expect(captured[0].url).toContain(
      encodeURIComponent("@elizaos/plugin-calendar"),
    );
    expect(captured[0].body).toEqual({ enabled: false });
  });

  it("fails without a valid `enabled` boolean instead of guessing", async () => {
    const { captured, restore } = stubFetch({ success: true });
    restoreFetch = restore;

    const result = await pluginAction.handler(
      runtime,
      { content: { text: "" } } as never,
      undefined,
      { parameters: { action: "toggle", pluginId: "discord" } },
      undefined,
    );

    expect(result?.success).toBe(false);
    // No network call when the required param is missing.
    expect(captured).toHaveLength(0);
  });
});
