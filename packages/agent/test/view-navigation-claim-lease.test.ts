import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ElizaError, type IAgentRuntime, type UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeViewInteractionHost,
  NAVIGATION_BUSY_WAIT_MS,
  NAVIGATION_CLAIM_LEASE_MS,
  ViewInteractionHost,
} from "../src/api/view-interaction-host.ts";
import {
  closeRuntimeViewRegistry,
  getView,
  registerBuiltinViews,
  registerPluginViews,
} from "../src/api/views-registry.ts";
import {
  getCurrentViewState,
  handleViewsRoutes,
} from "../src/api/views-routes.ts";

const owner = "11111111-1111-4111-8111-111111111111" as UUID;
const principal = "55555555-5555-4555-8555-555555555555" as UUID;
const roles = ["OWNER" as const];
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function viewRuntime() {
  const runtime = {
    agentId: "44444444-4444-4444-8444-444444444444",
    actions: [],
    getRoom: async () => ({ worldId: "world" }),
    getWorld: async () => ({
      id: "world",
      metadata: {
        roles: { [owner]: "OWNER" },
        ownership: { ownerId: owner },
      },
    }),
    getSetting: () => undefined,
    getEntityById: async () => null,
    emitEvent: async () => undefined,
    reportError: vi.fn(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as IAgentRuntime;
  registerBuiltinViews(runtime);
  await registerPluginViews(
    runtime,
    {
      name: "test-claim-lease-views",
      description: "Fixture view owner",
      views: [
        { id: "notes", label: "Notes", path: "/notes", bundleUrl: "/notes.js" },
        {
          id: "calendar",
          label: "Calendar",
          path: "/calendar",
          bundleUrl: "/calendar.js",
        },
      ],
    },
    { pluginDir: process.cwd(), indexEmbeddings: false },
  );
  cleanup.push(() => closeRuntimeViewRegistry(runtime));
  return runtime;
}

async function hostFixture() {
  const runtime = await viewRuntime();
  const host = new ViewInteractionHost(runtime);
  cleanup.push(() => host.close());
  const entry = (id: string) => {
    const view = getView(runtime, id, { viewType: "gui" });
    if (!view) throw Error(`Missing ${id}`);
    return view;
  };
  const binding = (requestId: string, viewId: string) => ({
    requestId,
    viewId,
    viewType: "gui",
    installationId: entry(viewId).installationId as string,
  });
  const navigate = (requestId: string, viewId: string) =>
    host.waitFor(requestId, "origin-client", entry(viewId), 120000, {
      ownerId: owner,
      navigation: true,
    });
  const claim = (requestId: string, viewId: string) =>
    host.claim("origin-client", binding(requestId, viewId), roles, owner);
  const settle = (
    requestId: string,
    viewId: string,
    claimId: string,
    switched = true,
  ) =>
    host.resolve(
      "origin-client",
      {
        ...binding(requestId, viewId),
        claimId,
        success: switched,
        result: { switched },
      },
      owner,
    );
  return { host, entry, navigate, claim, settle };
}

function errorCode(error: unknown) {
  return error instanceof ElizaError ? error.code : String(error);
}

describe("navigation claim lease", () => {
  it("bounds the renderer deadlines it is derived from and the agent preparation deadline", () => {
    // Renderer claim deadline (5 s) plus its negative cleanup (1.5 s) must fit.
    expect(NAVIGATION_CLAIM_LEASE_MS).toBeGreaterThan(5000 + 1500);
    expect(NAVIGATION_CLAIM_LEASE_MS).toBeLessThan(120000);
    // The VIEWS action aborts its preparation request after 5 s.
    expect(NAVIGATION_BUSY_WAIT_MS).toBeLessThan(5000);
  });

  it("retires a lost claim as not delivered so a new navigation proceeds after the lease", async () => {
    vi.useFakeTimers();
    const f = await hostFixture();
    const lost = f.navigate("boot-report", "chat");
    const outcome = lost.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    // Granted on the host, but the response never reached the renderer.
    const lostClaimId = f.claim("boot-report", "chat");
    expect(lostClaimId).toEqual(expect.any(String));
    expect(() => f.navigate("open-calendar", "calendar")).toThrow(
      expect.objectContaining({ code: "VIEW_NAVIGATION_BUSY" }),
    );
    await vi.advanceTimersByTimeAsync(NAVIGATION_CLAIM_LEASE_MS - 1);
    expect(() => f.navigate("open-calendar", "calendar")).toThrow(
      expect.objectContaining({ code: "VIEW_NAVIGATION_BUSY" }),
    );
    await vi.advanceTimersByTimeAsync(1);
    const settled = await outcome;
    // The original waiter fails honestly; it never resolves as delivered.
    expect("value" in settled).toBe(false);
    expect(errorCode((settled as { error: unknown }).error)).toBe(
      "VIEW_NAVIGATION_CLAIM_EXPIRED",
    );
    // A late acknowledgment for the expired claim is not accepted.
    expect(f.settle("boot-report", "chat", lostClaimId as string)).toBe(false);
    const next = f.navigate("open-calendar", "calendar");
    const claimId = f.claim("open-calendar", "calendar");
    expect(claimId).toEqual(expect.any(String));
    expect(f.settle("open-calendar", "calendar", claimId as string)).toBe(true);
    await expect(next).resolves.toMatchObject({
      success: true,
      result: { switched: true },
    });
  });

  it("leaves a claim that settles within its lease unaffected", async () => {
    vi.useFakeTimers();
    const f = await hostFixture();
    const pending = f.navigate("in-progress", "notes");
    const claimId = f.claim("in-progress", "notes") as string;
    await vi.advanceTimersByTimeAsync(NAVIGATION_CLAIM_LEASE_MS - 500);
    expect(f.settle("in-progress", "notes", claimId)).toBe(true);
    await expect(pending).resolves.toMatchObject({
      requestId: "in-progress",
      success: true,
      result: { switched: true },
    });
    // The cleared lease cannot later cancel a reused slot or a newer waiter.
    const next = f.navigate("after-settle", "calendar");
    const nextOutcome = next.then(
      () => "resolved",
      (error: unknown) => errorCode(error),
    );
    await vi.advanceTimersByTimeAsync(NAVIGATION_CLAIM_LEASE_MS * 2);
    const nextClaim = f.claim("after-settle", "calendar") as string;
    expect(f.settle("after-settle", "calendar", nextClaim)).toBe(true);
    expect(await nextOutcome).toBe("resolved");
  });

  it("keeps a re-claim refused so duplicate renderer sockets cannot both execute", async () => {
    vi.useFakeTimers();
    const f = await hostFixture();
    const pending = f.navigate("claimed-once", "notes");
    pending.catch(() => undefined);
    const claimId = f.claim("claimed-once", "notes");
    expect(claimId).toEqual(expect.any(String));
    // A second claim for the same client never receives the claimId: the
    // claim is the exactly-once execution grant, so the lease, not a re-claim,
    // is what recovers a claim whose response was lost.
    expect(f.claim("claimed-once", "notes")).toBeNull();
    await vi.advanceTimersByTimeAsync(NAVIGATION_CLAIM_LEASE_MS);
    await expect(pending).rejects.toMatchObject({
      code: "VIEW_NAVIGATION_CLAIM_EXPIRED",
    });
    expect(f.claim("claimed-once", "notes")).toBeNull();
  });

  it("does not lease non-navigation interactions", async () => {
    vi.useFakeTimers();
    const f = await hostFixture();
    const pending = f.host.waitFor(
      "long-interaction",
      "origin-client",
      f.entry("notes"),
      60000,
      { ownerId: owner },
    );
    const claimId = f.claim("long-interaction", "notes") as string;
    await vi.advanceTimersByTimeAsync(NAVIGATION_CLAIM_LEASE_MS * 3);
    expect(
      f.host.resolve(
        "origin-client",
        {
          requestId: "long-interaction",
          viewId: "notes",
          viewType: "gui",
          installationId: f.entry("notes").installationId,
          claimId,
          success: true,
          result: { done: true },
        },
        owner,
      ),
    ).toBe(true);
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it("serializes concurrent navigations behind a claimed one and lets the newest win", async () => {
    vi.useFakeTimers();
    const f = await hostFixture();
    const first = f.navigate("first", "notes");
    const firstClaim = f.claim("first", "notes") as string;
    const waits = [
      f.host.navigationIdle("origin-client", owner, NAVIGATION_BUSY_WAIT_MS),
      f.host.navigationIdle("origin-client", owner, NAVIGATION_BUSY_WAIT_MS),
    ];
    let idle = 0;
    for (const wait of waits) void wait.then(() => idle++);
    await vi.advanceTimersByTimeAsync(100);
    expect(idle).toBe(0);
    expect(f.settle("first", "notes", firstClaim)).toBe(true);
    await expect(first).resolves.toMatchObject({ success: true });
    await Promise.all(waits);
    // Both proceed one after another; the newer preparation supersedes the
    // older unclaimed one, so only one destination can ever be claimed.
    const second = f.navigate("second", "calendar");
    const third = f.navigate("third", "notes");
    await expect(second).rejects.toMatchObject({
      code: "VIEW_NAVIGATION_SUPERSEDED",
    });
    expect(f.claim("second", "calendar")).toBeNull();
    const thirdClaim = f.claim("third", "notes") as string;
    // While the newest is claimed, another preparation is still refused.
    expect(() => f.navigate("fourth", "calendar")).toThrow(
      expect.objectContaining({ code: "VIEW_NAVIGATION_BUSY" }),
    );
    expect(f.settle("third", "notes", thirdClaim)).toBe(true);
    await expect(third).resolves.toMatchObject({ success: true });
  });

  it("stops waiting at its bound and leaves the busy refusal to waitFor", async () => {
    vi.useFakeTimers();
    const f = await hostFixture();
    const held = f.navigate("held", "notes");
    held.catch(() => undefined);
    f.claim("held", "notes");
    let done = false;
    const wait = f.host
      .navigationIdle("origin-client", owner, NAVIGATION_BUSY_WAIT_MS)
      .then(() => {
        done = true;
      });
    await vi.advanceTimersByTimeAsync(NAVIGATION_BUSY_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(() => f.navigate("refused", "calendar")).toThrow(
      expect.objectContaining({ code: "VIEW_NAVIGATION_BUSY" }),
    );
    // A different renderer is never held by this one's claim.
    let other = false;
    await f.host
      .navigationIdle("other-client", owner, NAVIGATION_BUSY_WAIT_MS)
      .then(() => {
        other = true;
      });
    expect(other).toBe(true);
  });
});

describe("prepared navigation route behind a claimed navigation", () => {
  async function routeFixture() {
    const runtime = await viewRuntime();
    const hostKey = {};
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.headers.authorization !== "Bearer local-navigation-test") {
        res.writeHead(401).end();
        return;
      }
      void handleViewsRoutes({
        req,
        res,
        method: req.method ?? "GET",
        pathname: url.pathname,
        url,
        hostKey,
        runtime,
        callerAuthorization: { ok: true, role: "OWNER", identityId: principal },
        json: (response, body) => {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(body));
        },
        error: (response, message, code = 500) => {
          response.writeHead(code, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: message }));
        },
        broadcastWsToClientId: () => 1,
        broadcastWs: () => {
          throw Error("Global navigation is forbidden");
        },
      }).catch((error) => res.writeHead(500).end(String(error)));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(async () => {
      closeViewInteractionHost(hostKey);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) =>
      fetch(url + path, {
        method: "POST",
        headers: {
          authorization: "Bearer local-navigation-test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const prepare = (viewId: string, handoffId: string, source?: string) =>
      post(`/api/views/${viewId}/navigate`, {
        clientId: "origin-client",
        delivery: "completed-action",
        completedActionHandoffId: handoffId,
        viewType: "gui",
        prepareOnly: true,
        ...(source ? { source } : {}),
      });
    return { runtime, hostKey, post, prepare };
  }

  it("waits for an in-progress claim to settle instead of refusing the agent's navigation", async () => {
    const f = await routeFixture();
    const report = await f.prepare("chat", "renderer-report", "user");
    expect(report.status).toBe(200);
    const reportBinding = (await report.json()).navigationBinding;
    const reportClaim = await f.post(
      "/api/views/interact-claim",
      reportBinding,
    );
    expect(reportClaim.status).toBe(200);
    const { claimId } = await reportClaim.json();
    const agentPrepare = f.prepare("calendar", "agent-open-calendar");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      await (
        await f.post("/api/views/interact-result", {
          ...reportBinding,
          claimId,
          success: true,
          result: { switched: true },
        })
      ).json(),
    ).toMatchObject({ accepted: true });
    const prepared = await agentPrepare;
    expect(prepared.status).toBe(200);
    const body = await prepared.json();
    expect(body).toMatchObject({
      status: "prepared",
      completedActionHandoffId: "agent-open-calendar",
    });
    const scope = { hostKey: f.hostKey, clientId: "origin-client" };
    await vi.waitFor(() =>
      expect(getCurrentViewState(f.runtime, scope)?.viewId).toBe("chat"),
    );
    const claim = await f.post(
      "/api/views/interact-claim",
      body.navigationBinding,
    );
    expect(claim.status).toBe(200);
    expect(
      await (
        await f.post("/api/views/interact-result", {
          ...body.navigationBinding,
          claimId: (await claim.json()).claimId,
          success: true,
          result: { switched: true },
        })
      ).json(),
    ).toMatchObject({ accepted: true });
    // Prepared against the state the report committed, so this commit lands.
    await vi.waitFor(() =>
      expect(getCurrentViewState(f.runtime, scope)?.viewId).toBe("calendar"),
    );
  });

  it("still refuses with VIEW_NAVIGATION_BUSY when the claim outlasts the bounded wait", async () => {
    const f = await routeFixture();
    const report = await f.prepare("chat", "renderer-report-held", "user");
    const binding = (await report.json()).navigationBinding;
    expect((await f.post("/api/views/interact-claim", binding)).status).toBe(
      200,
    );
    const started = Date.now();
    const refused = await f.prepare("calendar", "agent-open-calendar-held");
    expect(refused.status).toBe(409);
    expect(Date.now() - started).toBeGreaterThanOrEqual(
      NAVIGATION_BUSY_WAIT_MS - 50,
    );
  });
});
