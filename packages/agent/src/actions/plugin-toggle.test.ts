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
import { promoteSubactionsToActions } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { pluginAction } from "./plugin.ts";

interface CapturedRequest {
  url: string;
  method?: string;
  body: unknown;
  headers?: HeadersInit;
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
      headers: init?.headers,
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

  it("is exposed even without plugin_manager so local connector/config ops can route", async () => {
    expect(
      await pluginAction.validate?.(
        { getService: () => null } as never,
        { content: { text: "turn on the discord connector" } } as never,
      ),
    ).toBe(true);
    expect(
      await pluginAction.validate?.(
        { getService: () => null } as never,
        { content: { text: "install the calendar plugin" } } as never,
        undefined,
        { parameters: { action: "install" } },
      ),
    ).toBe(false);
    expect(
      await pluginAction.validate?.(
        { getService: () => null } as never,
        { content: { text: "disable the discord connector" } } as never,
        undefined,
        { parameters: { action: "toggle" } },
      ),
    ).toBe(true);

    const virtuals = promoteSubactionsToActions(pluginAction);
    const install = virtuals.find((action) => action.name === "PLUGIN_INSTALL");
    const toggle = virtuals.find((action) => action.name === "PLUGIN_TOGGLE");
    await expect(
      install?.validate?.(
        { getService: () => null } as never,
        { content: { text: "install the calendar plugin" } } as never,
      ),
    ).resolves.toBe(false);
    await expect(
      toggle?.validate?.(
        { getService: () => null } as never,
        { content: { text: "disable the discord connector" } } as never,
      ),
    ).resolves.toBe(true);
  });

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

  it("attaches the process API token so cloud containers do not 401 loopback toggles", async () => {
    // Cloud-provisioned agents reject tokenless loopback. PLUGIN toggle must
    // send createSelfApiRequestHeaders() (Authorization: Bearer …) or the
    // local PUT /api/plugins/:id returns 401 Unauthorized.
    const previous = process.env.ELIZA_API_TOKEN;
    process.env.ELIZA_API_TOKEN = "cloud-container-api-token";
    const { captured, restore } = stubFetch({ success: true });
    restoreFetch = () => {
      restore();
      if (previous === undefined) {
        delete process.env.ELIZA_API_TOKEN;
      } else {
        process.env.ELIZA_API_TOKEN = previous;
      }
    };

    await invokeToggle("calendar", true);

    expect(captured).toHaveLength(1);
    expect(captured[0].headers).toMatchObject({
      Authorization: "Bearer cloud-container-api-token",
      "Content-Type": "application/json",
    });
  });
});

describe("PLUGIN action=list — an empty filtered view names its scope", () => {
  // Live 2026-08-14: "what apps or connectors am I connected to" answered
  // "You're not connected to anything right now" — while Discord was actively
  // delivering that very reply and 19 plugins were loaded. The tool had said
  // "No connectors match the requested filter", but never named the filter, so
  // the model dropped the qualifier and reported a filtered view as a total.
  it("states the filter and the pre-filter count", async () => {
    // `filter` is a ListFilter object — passing the bare string "disabled"
    // never reached applyListFilter and the empty branch was unreachable, so
    // the assertions below could not run at all.
    const stub = stubFetch({
      plugins: [
        { id: "discord", category: "connector", enabled: true, isActive: true },
        { id: "google", category: "connector", enabled: true, isActive: false },
      ],
    });
    try {
      const result = await pluginAction.handler(
        runtime,
        { content: { text: "" } } as never,
        undefined,
        {
          parameters: {
            action: "list",
            type: "connector",
            filter: { status: "disabled" },
          },
        },
        undefined,
      );
      const text = String(result?.text ?? "");
      expect(text).toContain("No connectors match");
      expect(text).toContain("status=disabled");
      expect(text).not.toContain("[object Object]");
      expect(text).toContain("2 connectors exist before filtering");
      expect(text).toContain("not a statement that none exist");
    } finally {
      stub.restore();
    }
  });
});

describe("PLUGIN action=list — a populated filtered view names its scope", () => {
  // The empty branch already disclosed its filter; the populated branch did
  // not. "which connectors are active?" rendered "Connectors (1):" over a
  // filtered subset while the unfiltered roster sat in `scoped`, and the model
  // told the user they had one connector.
  it("prints the pre-filter count and the filter in the header", async () => {
    const stub = stubFetch({
      plugins: [
        { id: "discord", category: "connector", enabled: true, isActive: true },
        { id: "google", category: "connector", enabled: true, isActive: false },
        { id: "slack", category: "connector", enabled: false, isActive: false },
      ],
    });
    try {
      const result = await pluginAction.handler(
        runtime,
        { content: { text: "" } } as never,
        undefined,
        {
          parameters: {
            action: "list",
            type: "connector",
            filter: { status: "active" },
          },
        },
        undefined,
      );
      const text = String(result?.text ?? "");
      expect(text).toContain("Connectors (1 of 3");
      expect(text).toContain("narrowed by status=active");
      expect(text).not.toContain("[object Object]");
      expect(result?.data).toMatchObject({ totalBeforeFilter: 3, count: 1 });
    } finally {
      stub.restore();
    }
  });

  it("keeps the plain header when nothing narrowed the list", async () => {
    const stub = stubFetch({
      plugins: [
        { id: "discord", category: "connector", enabled: true, isActive: true },
        { id: "google", category: "connector", enabled: true, isActive: false },
      ],
    });
    try {
      const result = await pluginAction.handler(
        runtime,
        { content: { text: "" } } as never,
        undefined,
        { parameters: { action: "list", type: "connector" } },
        undefined,
      );
      expect(String(result?.text ?? "")).toContain("Connectors (2):");
    } finally {
      stub.restore();
    }
  });
});
