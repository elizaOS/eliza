/**
 * Regression coverage for the absent-plugin route stub registry
 * (arch-audit #12089 item 12 / #12662).
 *
 * Guards two failure modes the old inline-per-plugin stubs were prone to:
 *  1. Schema drift — the same absent-plugin path used to be hand-mirrored in
 *     both handleBuiltinOptionalRoutes (server.ts) and handleMobileOptionalRoutes
 *     (mobile-optional-routes.ts) and had already diverged. We assert exact
 *     snapshots and that both host handlers now resolve from THIS registry.
 *  2. Central re-fabrication drifting back in — a grep guard proves the inline
 *     literal stubs are gone from both handlers' executable paths.
 */
import { readFileSync } from "node:fs";
import type http from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ABSENT_PLUGIN_ROUTE_STUBS,
  resolveAbsentPluginRouteStub,
} from "./absent-plugin-route-stubs.ts";

function req(url: string): http.IncomingMessage {
  return { url, method: "GET" } as unknown as http.IncomingMessage;
}

describe("absent-plugin route stub registry", () => {
  it("has a unique (method, path) per declared stub", () => {
    const seen = new Set<string>();
    for (const stub of ABSENT_PLUGIN_ROUTE_STUBS) {
      const key = `${stub.method} ${stub.path}`;
      expect(seen.has(key), `duplicate stub for ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("resolves nothing for an unowned path", () => {
    expect(resolveAbsentPluginRouteStub("GET", "/api/does-not-exist")).toBe(
      null,
    );
    // Method mismatch must not resolve a GET-only stub.
    expect(resolveAbsentPluginRouteStub("POST", "/api/voice/profiles")).toBe(
      null,
    );
  });

  it("produces the voice-profiles unavailable snapshot", () => {
    const stub = resolveAbsentPluginRouteStub("GET", "/api/voice/profiles");
    expect(stub?.capabilityId).toBe("voice-profiles");
    expect(stub?.buildBody(req("/api/voice/profiles"))).toEqual({
      profiles: [],
    });
  });

  it("produces the browser-bridge companions unavailable snapshot", () => {
    // A pure fabrication (no live plugin state) that used to live inline in
    // server.ts next to the live-state `/packages` probe; moved here so the
    // registry owns every fabricated absent-capability snapshot. The live
    // `/api/browser-bridge/packages` probe stays in the host handler.
    const stub = resolveAbsentPluginRouteStub(
      "GET",
      "/api/browser-bridge/companions",
    );
    expect(stub?.capabilityId).toBe("browser-bridge-companions");
    expect(stub?.buildBody(req("/api/browser-bridge/companions"))).toEqual({
      companions: [],
    });
  });

  it("produces the discord-local unavailable snapshot", () => {
    const stub = resolveAbsentPluginRouteStub(
      "GET",
      "/api/discord-local/status",
    );
    expect(stub?.buildBody(req("/api/discord-local/status"))).toEqual({
      available: false,
      connected: false,
      authenticated: false,
      currentUser: null,
      subscribedChannelIds: [],
      configuredChannelIds: [],
      scopes: [],
      lastError: null,
      ipcPath: null,
    });
  });

  it("produces the imessage unavailable snapshot with the host platform", () => {
    const stub = resolveAbsentPluginRouteStub(
      "GET",
      "/api/lifeops/connectors/imessage/status",
    );
    const body = stub?.buildBody(
      req("/api/lifeops/connectors/imessage/status"),
    );
    expect(body).toMatchObject({
      available: false,
      connected: false,
      bridgeType: "none",
      hostPlatform: process.platform,
      reason: "lifeops_route_unavailable",
      permissionAction: null,
    });
  });

  it("keeps Signal status as an explicit unsupported 501 declaration", () => {
    const stub = resolveAbsentPluginRouteStub("GET", "/api/signal/status");
    expect(stub?.capabilityId).toBe("signal-unsupported");
    expect(stub?.statusCode).toBe(501);
    expect(stub?.buildBody(req("/api/signal/status"))).toEqual({
      accountId: "default",
      status: "unsupported",
      available: false,
      supported: false,
      authExists: false,
      serviceConnected: false,
      qrDataUrl: null,
      phoneNumber: null,
      code: "SIGNAL_DIRECT_TRANSPORT_UNAVAILABLE",
      error:
        "Signal is unsupported because no bundled in-process transport is available.",
    });
    expect(
      stub?.buildBody(req("/api/signal/status?accountId=legacy-account")),
    ).toMatchObject({ accountId: "legacy-account", status: "unsupported" });
  });

  it("produces the telegram-account idle snapshot", () => {
    const stub = resolveAbsentPluginRouteStub(
      "GET",
      "/api/setup/telegram-account/status",
    );
    expect(stub?.buildBody(req("/api/setup/telegram-account/status"))).toEqual({
      connector: "telegram-account",
      state: "idle",
      detail: {
        status: "idle",
        configured: false,
        sessionExists: false,
        serviceConnected: false,
        restartRequired: false,
        hasAppCredentials: false,
        phone: null,
        isCodeViaApp: false,
        account: null,
        error: null,
      },
    });
  });

  it("echoes whatsapp accountId and only emits authScope for allowed scopes", () => {
    const stub = resolveAbsentPluginRouteStub("GET", "/api/whatsapp/status");
    // No authScope query → key omitted entirely.
    expect(stub?.buildBody(req("/api/whatsapp/status"))).toEqual({
      accountId: "default",
      status: "idle",
      authExists: false,
      serviceConnected: false,
      servicePhone: null,
    });
    // Allowed scope is echoed.
    expect(
      stub?.buildBody(
        req("/api/whatsapp/status?accountId=biz&authScope=platform"),
      ),
    ).toMatchObject({ accountId: "biz", authScope: "platform" });
    expect(
      stub?.buildBody(req("/api/whatsapp/status?authScope=lifeops")),
    ).toMatchObject({ authScope: "lifeops" });
    // Disallowed scope is dropped, not echoed.
    expect(
      stub?.buildBody(req("/api/whatsapp/status?authScope=bogus")),
    ).not.toHaveProperty("authScope");
  });

  it("produces the coding-agents preflight + coordinator unavailable snapshots", () => {
    expect(
      resolveAbsentPluginRouteStub(
        "GET",
        "/api/coding-agents/preflight",
      )?.buildBody(req("/api/coding-agents/preflight")),
    ).toEqual({ installed: [], available: false });

    expect(
      resolveAbsentPluginRouteStub(
        "GET",
        "/api/coding-agents/coordinator/status",
      )?.buildBody(req("/api/coding-agents/coordinator/status")),
    ).toEqual({
      supervisionLevel: "unavailable",
      taskCount: 0,
      tasks: [],
      pendingConfirmations: 0,
      taskThreadCount: 0,
      taskThreads: [],
      frameworks: [],
    });
  });

  it("owns lifeops activity-signals for both GET and POST with the canonical reason", () => {
    expect(
      resolveAbsentPluginRouteStub(
        "GET",
        "/api/lifeops/activity-signals",
      )?.buildBody(req("/api/lifeops/activity-signals")),
    ).toEqual({ signals: [] });

    const post = resolveAbsentPluginRouteStub(
      "POST",
      "/api/lifeops/activity-signals",
    );
    expect(post?.buildBody(req("/api/lifeops/activity-signals"))).toEqual({
      ok: true,
      stored: false,
      // Canonical value — mobile-optional-routes used to drift to
      // "lifeops_unavailable_in_mobile_local_mode"; now both resolve here.
      reason: "lifeops_route_unavailable",
    });
  });
});

describe("grep guard: inline absent-plugin stubs removed from host handlers", () => {
  const serverSrc = readFileSync(
    fileURLToPath(new URL("./server.ts", import.meta.url)),
    "utf8",
  );
  const mobileSrc = readFileSync(
    fileURLToPath(new URL("./mobile-optional-routes.ts", import.meta.url)),
    "utf8",
  );

  it("server.ts no longer inlines the moved stub literals", () => {
    // These distinctive literals only existed in the old inline stubs.
    for (const marker of [
      'connector: "telegram-account"',
      'supervisionLevel: "unavailable"',
      'bridgeType: "none"',
      "{ companions: [] }",
    ]) {
      expect(
        serverSrc.includes(marker),
        `server.ts still inlines '${marker}'`,
      ).toBe(false);
    }
    // The registry is wired in.
    expect(serverSrc).toContain("resolveAbsentPluginRouteStub");
  });

  it("mobile-optional-routes.ts no longer inlines the shared stub literals", () => {
    for (const marker of [
      'supervisionLevel: "unavailable"',
      "lifeops_unavailable_in_mobile_local_mode",
    ]) {
      expect(
        mobileSrc.includes(marker),
        `mobile-optional-routes.ts still inlines '${marker}'`,
      ).toBe(false);
    }
    expect(mobileSrc).toContain("resolveAbsentPluginRouteStub");
  });
});
