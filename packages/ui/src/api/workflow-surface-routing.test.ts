/** Verifies resolveWorkflowSurfaceTarget through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Verifies the workflow-surface cloud routing seam: a mobile on-device base
 * with a linked Cloud agent reroutes plugin-workflow calls to the Cloud base;
 * every other topology stays on the active client. In-memory localStorage, no
 * live cloud.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformMock = vi.hoisted(() => ({
  platform: "web" as "web" | "ios" | "android" | "desktop",
}));

vi.mock("../platform/platform-guards", () => ({
  getFrontendPlatform: () => platformMock.platform,
  isDynamicViewLoadingAllowed: () =>
    platformMock.platform !== "ios" && platformMock.platform !== "android",
  getActiveViewModality: () => "gui" as const,
}));

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { MOBILE_LOCAL_AGENT_API_BASE } from "../first-run/mobile-runtime-mode";
import type { AgentProfile } from "../state/agent-profile-types";
import { ElizaClient } from "./client-base";
import "./client-automations";
import "./client-workflow";
import {
  __resetWorkflowSurfaceRoutingForTest,
  resolveWorkflowSurfaceTarget,
  workflowSurfaceBaseUrl,
  workflowSurfaceClient,
} from "./workflow-surface-routing";

const IPC_BASE = "eliza-local-agent://ipc";
const SHARED_CLOUD_BASE =
  "https://api.elizacloud.ai/api/v1/eliza/agents/shared-agent-1";
const DEDICATED_CLOUD_BASE = "https://agent-abc.elizacloud.ai";

function seedProfiles(profiles: Array<Partial<AgentProfile>>): void {
  const registry = {
    version: 1,
    activeProfileId: null,
    profiles: profiles.map((profile, index) => ({
      id: profile.id ?? `profile-${index}`,
      label: profile.label ?? `Profile ${index}`,
      kind: profile.kind ?? "cloud",
      createdAt: profile.createdAt ?? "2026-07-01T00:00:00.000Z",
      ...profile,
    })),
  };
  window.localStorage.setItem(
    "elizaos:agent-profiles",
    JSON.stringify(registry),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  platformMock.platform = "web";
  __resetWorkflowSurfaceRoutingForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveWorkflowSurfaceTarget", () => {
  it("never reroutes on web or desktop, even with a linked Cloud agent", () => {
    seedProfiles([
      { kind: "cloud", apiBase: SHARED_CLOUD_BASE, accessToken: "jwt" },
    ]);
    expect(resolveWorkflowSurfaceTarget(IPC_BASE)).toBeNull();
    platformMock.platform = "desktop";
    expect(resolveWorkflowSurfaceTarget(IPC_BASE)).toBeNull();
  });

  it("never reroutes when the active base is not the bundled mobile runtime", () => {
    platformMock.platform = "ios";
    seedProfiles([
      { kind: "cloud", apiBase: SHARED_CLOUD_BASE, accessToken: "jwt" },
    ]);
    // Already on a cloud base — the active client serves the surface.
    expect(resolveWorkflowSurfaceTarget(SHARED_CLOUD_BASE)).toBeNull();
    // Remote paired host (full runtime, hosts plugin-workflow itself).
    expect(
      resolveWorkflowSurfaceTarget("http://192.168.1.20:31337"),
    ).toBeNull();
  });

  it("returns null on mobile-local with no linked Cloud agent (honest unavailable)", () => {
    platformMock.platform = "ios";
    seedProfiles([{ kind: "local", apiBase: IPC_BASE }]);
    expect(resolveWorkflowSurfaceTarget(IPC_BASE)).toBeNull();
  });

  it("routes mobile-local to the linked Cloud agent, normalizing a /bridge base", () => {
    platformMock.platform = "ios";
    seedProfiles([
      {
        kind: "cloud",
        apiBase: `${SHARED_CLOUD_BASE}/bridge`,
        accessToken: "profile-jwt",
      },
    ]);
    expect(resolveWorkflowSurfaceTarget(IPC_BASE)).toEqual({
      baseUrl: SHARED_CLOUD_BASE,
      token: "profile-jwt",
    });
  });

  it("prefers the live steward session token over the profile's captured copy", () => {
    platformMock.platform = "android";
    window.localStorage.setItem(STEWARD_TOKEN_KEY, "live-jwt");
    seedProfiles([
      { kind: "cloud", apiBase: SHARED_CLOUD_BASE, accessToken: "stale-jwt" },
    ]);
    expect(resolveWorkflowSurfaceTarget(MOBILE_LOCAL_AGENT_API_BASE)).toEqual({
      baseUrl: SHARED_CLOUD_BASE,
      token: "live-jwt",
    });
  });

  it("skips cloud profiles with no usable credential instead of routing into a 401", () => {
    platformMock.platform = "ios";
    seedProfiles([{ kind: "cloud", apiBase: SHARED_CLOUD_BASE }]);
    expect(resolveWorkflowSurfaceTarget(IPC_BASE)).toBeNull();
  });

  it("prefers a dedicated runtime (real workflow host) over a shared adapter base", () => {
    platformMock.platform = "ios";
    seedProfiles([
      {
        kind: "cloud",
        apiBase: SHARED_CLOUD_BASE,
        accessToken: "jwt",
        lastConnectedAt: "2026-07-20T00:00:00.000Z",
      },
      {
        kind: "cloud",
        apiBase: DEDICATED_CLOUD_BASE,
        accessToken: "jwt",
        lastConnectedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    expect(resolveWorkflowSurfaceTarget(IPC_BASE)?.baseUrl).toBe(
      DEDICATED_CLOUD_BASE,
    );
  });

  it("breaks ties between same-class bases on the most recent connection", () => {
    platformMock.platform = "ios";
    seedProfiles([
      {
        kind: "cloud",
        apiBase: "https://agent-old.elizacloud.ai",
        accessToken: "jwt",
        lastConnectedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        kind: "cloud",
        apiBase: DEDICATED_CLOUD_BASE,
        accessToken: "jwt",
        lastConnectedAt: "2026-07-22T00:00:00.000Z",
      },
    ]);
    expect(resolveWorkflowSurfaceTarget(IPC_BASE)?.baseUrl).toBe(
      DEDICATED_CLOUD_BASE,
    );
  });
});

describe("workflowSurfaceBaseUrl", () => {
  it("returns the active base unchanged when no reroute applies", () => {
    expect(workflowSurfaceBaseUrl("http://localhost:31337")).toBe(
      "http://localhost:31337",
    );
    expect(workflowSurfaceBaseUrl("")).toBe("");
  });

  it("returns the routed Cloud base on mobile-local with a linked agent", () => {
    platformMock.platform = "ios";
    seedProfiles([
      { kind: "cloud", apiBase: SHARED_CLOUD_BASE, accessToken: "jwt" },
    ]);
    expect(workflowSurfaceBaseUrl(IPC_BASE)).toBe(SHARED_CLOUD_BASE);
  });
});

describe("workflowSurfaceClient", () => {
  it("returns the active client itself when no reroute applies", () => {
    const active = new ElizaClient("http://localhost:31337", "local-token");
    expect(workflowSurfaceClient(active)).toBe(active);
  });

  it("returns a memoized Cloud-bound client on mobile-local with a linked agent", () => {
    platformMock.platform = "ios";
    seedProfiles([
      { kind: "cloud", apiBase: SHARED_CLOUD_BASE, accessToken: "cloud-jwt" },
    ]);
    const active = new ElizaClient(IPC_BASE);
    const routed = workflowSurfaceClient(active);
    expect(routed).not.toBe(active);
    expect(routed.baseUrl).toBe(SHARED_CLOUD_BASE);
    expect(routed.apiToken).toBe("cloud-jwt");
    expect(workflowSurfaceClient(active)).toBe(routed);
  });

  it("issues listAutomations and workflow CRUD against the routed Cloud client", async () => {
    platformMock.platform = "ios";
    seedProfiles([
      { kind: "cloud", apiBase: SHARED_CLOUD_BASE, accessToken: "cloud-jwt" },
    ]);
    const active = new ElizaClient(IPC_BASE);
    const routed = workflowSurfaceClient(active);
    const fetchSpy = vi.fn(async () => ({ automations: [] }));
    routed.fetch = fetchSpy as typeof routed.fetch;

    const controller = new AbortController();
    await active.listAutomations({
      timeoutMs: 6_000,
      signal: controller.signal,
    });
    await active.runWorkflowDefinition("wf-1").catch(() => {
      // run response shape is asserted elsewhere; only routing matters here
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "/api/automations",
      { signal: controller.signal },
      { timeoutMs: 6_000 },
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "/api/workflow/workflows/wf-1/run",
      { method: "POST", body: JSON.stringify({ input: {} }) },
      { timeoutMs: 30_000, skipResume: true },
    );
  });

  it("keeps listAutomations on the active client for a desktop runtime", async () => {
    const active = new ElizaClient("http://localhost:31337", "local-token");
    const fetchSpy = vi.fn(async () => ({ automations: [] }));
    active.fetch = fetchSpy as typeof active.fetch;

    await active.listAutomations();

    expect(fetchSpy).toHaveBeenCalledWith("/api/automations");
  });
});
