/**
 * ElizaClient choke-point recovery when a bound cloud agent is deleted.
 * Transport is stubbed; localStorage holds the stale active-server binding
 * under a jsdom harness.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import {
  loadAgentProfileRegistry,
  saveAgentProfileRegistry,
} from "../state/agent-profiles";
import {
  clearPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";
import { ElizaClient } from "./client-base";
import { ApiError } from "./client-types";
import type { AgentRequestTransport } from "./transport";

const DEAD_AGENT_BASE =
  "https://85a07f11-a3dc-4394-b1f2-318e22338afd.staging.elizacloud.ai";
const LIVE_AGENT_BASE =
  "https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.staging.elizacloud.ai";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ElizaClient stale cloud-agent binding release", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
    localStorage.clear();
    clearPersistedActiveServer();
  });

  afterEach(() => {
    localStorage.clear();
    clearPersistedActiveServer();
  });

  it("clears the live base + persisted binding on agent-gone 404", async () => {
    savePersistedActiveServer({
      id: "cloud:85a07f11-a3dc-4394-b1f2-318e22338afd",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: DEAD_AGENT_BASE,
    });
    saveAgentProfileRegistry({
      version: 1,
      activeProfileId: "profile-dead",
      profiles: [
        {
          id: "profile-dead",
          label: "Eliza Cloud",
          kind: "cloud",
          apiBase: DEAD_AGENT_BASE,
          createdAt: new Date().toISOString(),
        },
        {
          id: "profile-other",
          label: "Other",
          kind: "cloud",
          apiBase: LIVE_AGENT_BASE,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValue(
        jsonResponse(404, { error: "agent not found or not running", code: "agent_not_found" }),
      );

    const client = new ElizaClient(DEAD_AGENT_BASE, "token");
    client.setRequestTransport({ request });

    let caught: unknown;
    try {
      await client.fetch("/api/lifeops/activity-signals", { method: "POST" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(isCloudAgentGoneLike(caught)).toBe(true);
    expect(client.getBaseUrl()).toBe("");
    expect(loadPersistedActiveServer()).toBeNull();
    const registry = loadAgentProfileRegistry();
    // Survivor stays catalogued but is NOT auto-activated (no live connection).
    expect(registry.profiles.map((p) => p.id)).toEqual(["profile-other"]);
    expect(registry.activeProfileId).toBeNull();
    expect(localStorage.getItem("elizaos_api_base")).toBeNull();
  });

  it("releases on allowNonOk probes (health poll path)", async () => {
    savePersistedActiveServer({
      id: "cloud:dead",
      kind: "cloud",
      label: "Dead",
      apiBase: DEAD_AGENT_BASE,
    });

    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValue(
        jsonResponse(404, { error: "agent not found or not running", code: "agent_not_found" }),
      );

    const client = new ElizaClient(DEAD_AGENT_BASE, "token");
    client.setRequestTransport({ request });

    const res = await client.rawRequest("/api/status", undefined, {
      allowNonOk: true,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "agent not found or not running",
      code: "agent_not_found",
    });
    expect(client.getBaseUrl()).toBe("");
    expect(loadPersistedActiveServer()).toBeNull();
  });

  it("does not clear on recoverable agent_not_running (stopped/cold)", async () => {
    savePersistedActiveServer({
      id: "cloud:cold",
      kind: "cloud",
      label: "Cold",
      apiBase: DEAD_AGENT_BASE,
    });

    const request = vi.fn<AgentRequestTransport["request"]>().mockResolvedValue(
      jsonResponse(503, {
        error: "agent not running",
        code: "agent_not_running",
        status: "stopped",
      }),
    );

    const client = new ElizaClient(DEAD_AGENT_BASE, "token");
    client.setRequestTransport({ request });

    await expect(client.fetch("/api/status")).rejects.toBeInstanceOf(ApiError);
    expect(client.getBaseUrl()).toBe(DEAD_AGENT_BASE);
    expect(loadPersistedActiveServer()?.apiBase).toBe(DEAD_AGENT_BASE);
  });

  it("does not clear a newly selected binding when a stale response arrives late", async () => {
    savePersistedActiveServer({
      id: "cloud:live",
      kind: "cloud",
      label: "Live",
      apiBase: LIVE_AGENT_BASE,
    });
    saveAgentProfileRegistry({
      version: 1,
      activeProfileId: "profile-live",
      profiles: [
        {
          id: "profile-live",
          label: "Live",
          kind: "cloud",
          apiBase: LIVE_AGENT_BASE,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    let resolveDead!: (value: Response) => void;
    const deadResponse = new Promise<Response>((resolve) => {
      resolveDead = resolve;
    });
    const request = vi.fn<AgentRequestTransport["request"]>(async (url) => {
      if (String(url).startsWith(DEAD_AGENT_BASE)) {
        return deadResponse;
      }
      return jsonResponse(200, { ok: true });
    });

    const client = new ElizaClient(DEAD_AGENT_BASE, "token");
    client.setRequestTransport({ request });

    const pending = client.fetch("/api/lifeops/activity-signals", {
      method: "POST",
    });
    // User switches to a healthy agent while the dead request is in flight.
    client.setBaseUrl(LIVE_AGENT_BASE);
    savePersistedActiveServer({
      id: "cloud:live",
      kind: "cloud",
      label: "Live",
      apiBase: LIVE_AGENT_BASE,
    });

    resolveDead(jsonResponse(404, { error: "agent not found or not running", code: "agent_not_found" }));
    await expect(pending).rejects.toBeInstanceOf(ApiError);

    expect(client.getBaseUrl()).toBe(LIVE_AGENT_BASE);
    expect(loadPersistedActiveServer()?.apiBase).toBe(LIVE_AGENT_BASE);
    expect(loadAgentProfileRegistry().activeProfileId).toBe("profile-live");
  });

  it("does not clear a local agent binding on an unrelated 404", async () => {
    savePersistedActiveServer({
      id: "local",
      kind: "local",
      label: "Local",
      apiBase: "http://127.0.0.1:3000",
    });

    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValue(jsonResponse(404, { error: "route missing" }));

    const client = new ElizaClient("http://127.0.0.1:3000", "token");
    client.setRequestTransport({ request });

    await expect(client.fetch("/api/missing")).rejects.toBeInstanceOf(ApiError);
    expect(client.getBaseUrl()).toBe("http://127.0.0.1:3000");
    expect(loadPersistedActiveServer()?.apiBase).toBe("http://127.0.0.1:3000");
  });

  it("releases only once per dead base (idempotent under concurrent posts)", async () => {
    const request = vi
      .fn<AgentRequestTransport["request"]>()
      .mockResolvedValue(
        jsonResponse(404, { error: "agent not found or not running", code: "agent_not_found" }),
      );

    const client = new ElizaClient(DEAD_AGENT_BASE, "token");
    client.setRequestTransport({ request });
    savePersistedActiveServer({
      id: "cloud:dead",
      kind: "cloud",
      label: "Dead",
      apiBase: DEAD_AGENT_BASE,
    });

    await Promise.allSettled([
      client.fetch("/api/lifeops/activity-signals", { method: "POST" }),
      client.fetch("/api/lifeops/activity-signals", { method: "POST" }),
    ]);

    expect(client.getBaseUrl()).toBe("");
    expect(loadPersistedActiveServer()).toBeNull();
  });
});

function isCloudAgentGoneLike(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    error.message.includes("agent not found or not running")
  );
}
