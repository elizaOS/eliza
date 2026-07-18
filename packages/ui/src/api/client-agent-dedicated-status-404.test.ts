/**
 * #15310 failure #4: a RETURNING user whose existing Eliza Cloud agent is
 * DEDICATED (its own `<id>.elizacloud.ai` subdomain) is bound to that subdomain
 * base, but the dedicated agent ingress does not expose every local-agent probe
 * endpoint (`/api/status`, `/api/config`) to browser clients. Before the fix,
 * those probes produced noisy 401/404 console entries even though dedicated REST
 * chat was live.
 *
 * `getStatus()` must instead treat a dedicated cloud base like the shared REST
 * adapter: RUNNING without probing `/api/status`. Startup still uses
 * `/api/conversations` as the authoritative warm-passthrough gate before chat.
 *
 * Transport stubbed, no live agent, no desktop RPC (plain HTTP status path).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import "./client-agent";
import type { AgentRequestTransport } from "./transport";

function makeClient(
  baseUrl: string,
  handler: AgentRequestTransport["request"],
  token = "token",
): ElizaClient {
  const client = new ElizaClient(baseUrl, token);
  client.setRequestTransport({ request: vi.fn(handler) });
  return client;
}

const DEDICATED_BASE = "https://agent-abc123.elizacloud.ai";
const SHELL_CLIENT_ID_KEY = Symbol.for("elizaos.ui.client-id");

function sharedResolver404(): Response {
  return new Response(JSON.stringify({ error: "Not a shared-runtime agent" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

describe("ElizaClient.getStatus — dedicated agent shared-resolver 404 (#15310 #4)", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, SHELL_CLIENT_ID_KEY);
    // No desktop electrobun RPC / native lifecycle — force the plain HTTP path.
    Reflect.deleteProperty(globalThis, "window");
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, SHELL_CLIENT_ID_KEY);
    Reflect.deleteProperty(globalThis, "window");
  });

  it("short-circuits authenticated dedicated status as RUNNING without probing /api/status", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw new Error("/api/status should not be probed for dedicated cloud");
    });
    const client = makeClient(DEDICATED_BASE, request);

    const status = await client.getStatus();

    expect(status.state).toBe("running");
    expect(status.canRespond).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("short-circuits dedicated status even before token hydration", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw new Error("/api/status should not be probed for dedicated cloud");
    });
    const client = makeClient(DEDICATED_BASE, request, "");

    const status = await client.getStatus();

    expect(status.state).toBe("running");
    expect(status.canRespond).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("does NOT treat the shared-resolver 404 as running for a NON-dedicated base", async () => {
    // A loopback / self-hosted agent base that happens to 404 with the same
    // body is not a dedicated cloud agent — the running short-circuit must be
    // scoped to dedicated cloud bases only, so this still throws.
    const client = makeClient("http://127.0.0.1:31337", async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") return sharedResolver404();
      return new Response("{}", { status: 200 });
    });

    await expect(client.getStatus()).rejects.toThrow();
  });

  it("keeps the per-tab client scope on dedicated requests while omitting the unsupported UI language", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = makeClient(DEDICATED_BASE, request);
    client.setUiLanguage("en");

    await client.fetch("/api/status", {
      headers: {
        "X-ElizaOS-Client-Id": "manual-client-id",
        "X-ElizaOS-UI-Language": "es",
      },
    });

    const headers = request.mock.calls[0]?.[1].headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer token");
    const lowerHeaderNames = Object.keys(headers).map((key) =>
      key.toLowerCase(),
    );
    expect(headers["X-ElizaOS-Client-Id"]).toBe("manual-client-id");
    expect(lowerHeaderNames).not.toContain("x-elizaos-ui-language");
  });

  it("keeps two dedicated browser tabs in distinct current-view scopes", async () => {
    const currentViews = new Map<string, string>();
    const request = vi.fn<AgentRequestTransport["request"]>(
      async (url, init) => {
        const clientId = new Headers(init.headers).get("X-ElizaOS-Client-Id");
        if (!clientId) throw new Error("missing dedicated client scope");
        const pathname = new URL(url).pathname;
        const navigate = pathname.match(/^\/api\/views\/([^/]+)\/navigate$/);
        if (navigate) {
          currentViews.set(clientId, decodeURIComponent(navigate[1]));
          return Response.json({ ok: true });
        }
        if (pathname === "/api/views/current") {
          return Response.json({
            currentView: { viewId: currentViews.get(clientId) ?? null },
          });
        }
        throw new Error(`unexpected request: ${pathname}`);
      },
    );

    Reflect.set(globalThis, SHELL_CLIENT_ID_KEY, "ui-dedicated-tab-a");
    const tabA = makeClient(DEDICATED_BASE, request);
    Reflect.set(globalThis, SHELL_CLIENT_ID_KEY, "ui-dedicated-tab-b");
    const tabB = makeClient(DEDICATED_BASE, request);

    await Promise.all([
      tabA.fetch("/api/views/notes/navigate", { method: "POST", body: "{}" }),
      tabB.fetch("/api/views/simple-calendar/navigate", {
        method: "POST",
        body: "{}",
      }),
    ]);
    const [currentA, currentB] = await Promise.all([
      tabA.fetch<{ currentView: { viewId: string } }>("/api/views/current"),
      tabB.fetch<{ currentView: { viewId: string } }>("/api/views/current"),
    ]);

    expect(tabA.getClientId()).toBe("ui-dedicated-tab-a");
    expect(tabB.getClientId()).toBe("ui-dedicated-tab-b");
    expect(currentA.currentView.viewId).toBe("notes");
    expect(currentB.currentView.viewId).toBe("simple-calendar");
    expect(currentViews).toEqual(
      new Map([
        ["ui-dedicated-tab-a", "notes"],
        ["ui-dedicated-tab-b", "simple-calendar"],
      ]),
    );
  });

  it("short-circuits authenticated dedicated config as empty without probing /api/config", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw new Error("/api/config should not be probed for dedicated cloud");
    });
    const client = makeClient(DEDICATED_BASE, request);

    await expect(client.getConfig()).resolves.toEqual({});
    expect(request).not.toHaveBeenCalled();
  });
});
