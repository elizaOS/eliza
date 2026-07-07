/**
 * #15310 failure #4: a RETURNING user whose existing Eliza Cloud agent is
 * DEDICATED (its own `<id>.elizacloud.ai` subdomain) is bound to that subdomain
 * base, but the cloud agent-router proxies `/api/status` through the
 * shared-runtime resolver, which answers `404 { error: "Not a shared-runtime
 * agent" }` for a dedicated agent. Before the fix, that 404 threw out of
 * `getStatus()`, the readiness poll swallowed it, and the launcher wedged on
 * "Initializing agent…" FOREVER — the reported first-run hang for returning
 * accounts with an existing ready agent.
 *
 * `getStatus()` must instead treat that specific shared-resolver 404 (only when
 * bound to a dedicated cloud agent base) as RUNNING, so startup proceeds to
 * chat. Any OTHER 404 / 5xx / network error still propagates so a genuinely
 * broken agent surfaces honestly.
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
): ElizaClient {
  const client = new ElizaClient(baseUrl, "token");
  client.setRequestTransport({ request: vi.fn(handler) });
  return client;
}

const DEDICATED_BASE = "https://agent-abc123.elizacloud.ai";

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
    // No desktop electrobun RPC / native lifecycle — force the plain HTTP path.
    Reflect.deleteProperty(globalThis, "window");
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("treats the dedicated 'Not a shared-runtime agent' 404 as RUNNING (no wedge)", async () => {
    let statusCalls = 0;
    const client = makeClient(DEDICATED_BASE, async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") {
        statusCalls += 1;
        return sharedResolver404();
      }
      return new Response("{}", { status: 200 });
    });

    const status = await client.getStatus();

    // The returning user's dedicated agent is provisioned + serving chat over
    // REST — report running so the readiness poll advances to chat.
    expect(status.state).toBe("running");
    expect(status.canRespond).toBe(true);
    expect(statusCalls).toBe(1);
  });

  it("does NOT mask a generic 404 from a dedicated agent (only the shared-resolver signal is running)", async () => {
    const client = makeClient(DEDICATED_BASE, async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") {
        return new Response(JSON.stringify({ error: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    });

    // A generic 404 (a genuinely missing/broken status endpoint) still throws —
    // it must NOT be swallowed as "running", or a truly broken agent would look
    // healthy.
    await expect(client.getStatus()).rejects.toThrow();
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
});
