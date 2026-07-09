// Exercises container job executors behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import type { AppContainerProvider, ProvisionedAppContainer } from "../app-container-provider";
import {
  type AppContainerRow,
  type AppContainerStore,
  executeContainerDelete,
  executeContainerLogs,
  executeContainerProvision,
  executeContainerRestart,
} from "../container-job-executors";

const ROW: AppContainerRow = {
  id: "container-1",
  appId: "11111111-2222-3333-4444-555555555555",
  containerName: "app-nubilio",
  image: "ghcr.io/nubs/nubilio:latest",
  port: 3000,
  organizationId: "org-1",
  userId: "user-1",
  environmentVars: { DATABASE_URL: "postgresql://app_x:pw@cluster1/db_app_x" },
};

function fakeStore(row: AppContainerRow | null = ROW) {
  const events: Array<{ op: string; id: string; info?: unknown }> = [];
  const store: AppContainerStore = {
    async getById() {
      return row;
    },
    async markRunning(id, info) {
      events.push({ op: "running", id, info });
    },
    async markDeleted(id) {
      events.push({ op: "deleted", id });
    },
    async markError(id, error) {
      events.push({ op: "error", id, info: error });
    },
  };
  return { events, store };
}

function fakeProvider(over: Partial<Record<keyof AppContainerProvider, unknown>> = {}) {
  const calls: Array<{ op: string; arg: unknown }> = [];
  const provider = {
    async provision(params: unknown): Promise<ProvisionedAppContainer> {
      calls.push({ op: "provision", arg: params });
      return { containerId: "docker-abc", hostPort: 49001, network: "app-net-x" };
    },
    async delete(name: string) {
      calls.push({ op: "delete", arg: name });
    },
    async restart(name: string) {
      calls.push({ op: "restart", arg: name });
    },
    async logs(name: string, tail?: number) {
      calls.push({ op: "logs", arg: { name, tail } });
      return "log output";
    },
    ...over,
  } as unknown as AppContainerProvider;
  return { calls, provider };
}

const job = (data: unknown) => ({ id: "job-1", data });

describe("executeContainerProvision", () => {
  test("builds input from the row, provisions, and marks running", async () => {
    const { events, store } = fakeStore();
    const { calls, provider } = fakeProvider();
    await executeContainerProvision(
      job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
      {
        provider,
        store,
      },
    );

    const provisionCall = calls.find((c) => c.op === "provision");
    expect(provisionCall).toBeDefined();
    // input carries the row's image + the per-tenant DSN, NOT a shared one
    const arg = provisionCall?.arg as {
      input: { image: string; environmentVars?: Record<string, string> };
    };
    expect(arg.input.image).toBe(ROW.image);
    expect(arg.input.environmentVars?.DATABASE_URL).toContain("db_app_x");

    expect(events).toEqual([
      {
        op: "running",
        id: "container-1",
        info: { hostContainerId: "docker-abc", hostPort: 49001, network: "app-net-x" },
      },
    ]);
  });

  test("flips the linked app to deployed on success (#5: deploy reaches READY)", async () => {
    const { store } = fakeStore();
    const { provider } = fakeProvider();
    const deployed: Array<{ appId: string; url: string | null }> = [];
    await executeContainerProvision(
      job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
      {
        provider,
        store,
        markAppDeployed: async (appId, url) => {
          deployed.push({ appId, url });
        },
      },
    );
    expect(deployed).toHaveLength(1);
    expect(deployed[0]?.appId).toBe(ROW.appId);
  });

  test("does NOT mark the app deployed when provisioning fails", async () => {
    const { store } = fakeStore();
    const { provider } = fakeProvider({
      async provision() {
        throw new Error("docker create failed");
      },
    } as never);
    const deployedOnFail: string[] = [];
    await expect(
      executeContainerProvision(
        job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
        {
          provider,
          store,
          markAppDeployed: async (appId) => {
            deployedOnFail.push(appId);
          },
        },
      ),
    ).rejects.toThrow("docker create failed");
    expect(deployedOnFail).toEqual([]);
  });

  test("marks error and rethrows when provisioning fails", async () => {
    const { events, store } = fakeStore();
    const { provider } = fakeProvider({
      async provision() {
        throw new Error("docker create failed");
      },
    } as never);
    await expect(
      executeContainerProvision(
        job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
        {
          provider,
          store,
        },
      ),
    ).rejects.toThrow("docker create failed");
    expect(events[0]).toMatchObject({ op: "error", id: "container-1" });
  });

  test("throws when the container row is missing", async () => {
    const { store } = fakeStore(null);
    const { provider } = fakeProvider();
    await expect(
      executeContainerProvision(job({ containerId: "gone", organizationId: "o", userId: "u" }), {
        provider,
        store,
      }),
    ).rejects.toThrow("not found");
  });

  test("route-add failure AFTER markRunning keeps the row running, never failed", async () => {
    const prev = process.env.CONTAINERS_PUBLIC_BASE_DOMAIN;
    process.env.CONTAINERS_PUBLIC_BASE_DOMAIN = "apps.elizacloud.ai";
    try {
      const { events, store } = fakeStore();
      const { provider } = fakeProvider();
      await expect(
        executeContainerProvision(
          job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
          {
            provider,
            store,
            // Caddy unreachable: the route add fails AFTER the container is running.
            onRouteAdded: async () => {
              throw new Error("caddy unreachable");
            },
          },
        ),
      ).rejects.toThrow("caddy unreachable");
      // The container WAS marked running (it is live), and was NOT flipped to
      // error — a live, working container must never look reapable/failed.
      expect(events.some((e) => e.op === "running")).toBe(true);
      expect(events.some((e) => e.op === "error")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CONTAINERS_PUBLIC_BASE_DOMAIN;
      else process.env.CONTAINERS_PUBLIC_BASE_DOMAIN = prev;
    }
  });

  test("#9853: marks deployed only after the public URL is reachable", async () => {
    const prev = process.env.CONTAINERS_PUBLIC_BASE_DOMAIN;
    process.env.CONTAINERS_PUBLIC_BASE_DOMAIN = "apps.elizacloud.ai";
    try {
      const { store } = fakeStore();
      const { provider } = fakeProvider();
      const probed: string[] = [];
      const deployed: string[] = [];
      await executeContainerProvision(
        job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
        {
          provider,
          store,
          probeAppReachable: async (url) => {
            probed.push(url);
            return true;
          },
          markAppDeployed: async (appId) => {
            deployed.push(appId);
          },
        },
      );
      expect(probed).toHaveLength(1);
      expect(probed[0]).toContain("apps.elizacloud.ai");
      expect(deployed).toEqual([ROW.appId]);
    } finally {
      if (prev === undefined) delete process.env.CONTAINERS_PUBLIC_BASE_DOMAIN;
      else process.env.CONTAINERS_PUBLIC_BASE_DOMAIN = prev;
    }
  });

  test("#9853: an unreachable public URL throws and never marks deployed", async () => {
    const prev = process.env.CONTAINERS_PUBLIC_BASE_DOMAIN;
    process.env.CONTAINERS_PUBLIC_BASE_DOMAIN = "apps.elizacloud.ai";
    try {
      const { events, store } = fakeStore();
      const { provider } = fakeProvider();
      const deployed: string[] = [];
      await expect(
        executeContainerProvision(
          job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
          {
            provider,
            store,
            // Container is live and routed, but the app never answers.
            probeAppReachable: async () => false,
            markAppDeployed: async (appId) => {
              deployed.push(appId);
            },
          },
        ),
      ).rejects.toThrow("not HTTP-reachable");
      // Deploy NOT reported as success...
      expect(deployed).toEqual([]);
      // ...but the live container stays `running`, never flipped to `error`.
      expect(events.some((e) => e.op === "running")).toBe(true);
      expect(events.some((e) => e.op === "error")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CONTAINERS_PUBLIC_BASE_DOMAIN;
      else process.env.CONTAINERS_PUBLIC_BASE_DOMAIN = prev;
    }
  });
});

describe("executeContainerDelete / restart / logs", () => {
  test("delete removes the container then marks it deleted", async () => {
    const { events, store } = fakeStore();
    const { calls, provider } = fakeProvider();
    await executeContainerDelete(job({ containerId: "container-1", organizationId: "org-1" }), {
      provider,
      store,
    });
    expect(calls.find((c) => c.op === "delete")?.arg).toBe("app-nubilio");
    expect(events).toEqual([{ op: "deleted", id: "container-1" }]);
  });

  test("restart restarts by container name", async () => {
    const { store } = fakeStore();
    const { calls, provider } = fakeProvider();
    await executeContainerRestart(job({ containerId: "container-1", organizationId: "org-1" }), {
      provider,
      store,
    });
    expect(calls.find((c) => c.op === "restart")?.arg).toBe("app-nubilio");
  });

  test("logs returns the provider output for the requested tail", async () => {
    const { store } = fakeStore();
    const { calls, provider } = fakeProvider();
    const out = await executeContainerLogs(
      job({ containerId: "container-1", organizationId: "org-1", tail: 50 }),
      { provider, store },
    );
    expect(out).toBe("log output");
    expect(calls.find((c) => c.op === "logs")?.arg).toEqual({ name: "app-nubilio", tail: 50 });
  });
});

describe("ingress route hooks", () => {
  const BASE = "CONTAINERS_PUBLIC_BASE_DOMAIN";
  function withBase<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = process.env[BASE];
    if (value === undefined) delete process.env[BASE];
    else process.env[BASE] = value;
    return fn().finally(() => {
      if (prev === undefined) delete process.env[BASE];
      else process.env[BASE] = prev;
    });
  }

  test("provision adds the route (host + hostPort, NO nodeHost in the dial) + threads nodeHost to markRunning", async () => {
    await withBase("apps.elizacloud.ai", async () => {
      const { events, store } = fakeStore();
      const { provider } = fakeProvider({
        async provision() {
          return {
            containerId: "docker-abc",
            hostPort: 49001,
            network: "app-net-x",
            nodeHost: "10.30.1.5",
          };
        },
      } as never);
      const routes: Array<{ hostname: string; hostPort: number; nodeHost?: string }> = [];
      await executeContainerProvision(
        job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
        {
          provider,
          store,
          onRouteAdded: async (r) => {
            routes.push(r);
          },
        },
      );
      expect(routes).toHaveLength(1);
      expect(routes[0].hostname).toMatch(/\.apps\.elizacloud\.ai$/);
      expect(routes[0]).toMatchObject({ hostPort: 49001 });
      // The route no longer carries nodeHost — the dial is node-local loopback,
      // so the node IP must NOT leak into the ingress hook.
      expect(routes[0].nodeHost).toBeUndefined();
      // nodeHost is still persisted to the container record (markRunning), which
      // is a separate concern from the loopback ingress dial.
      expect(events.find((e) => e.op === "running")?.info).toMatchObject({ nodeHost: "10.30.1.5" });
    });
  });

  test("provision folds the app's verified custom domains into the route", async () => {
    await withBase("apps.elizacloud.ai", async () => {
      const { store } = fakeStore();
      const { provider } = fakeProvider({
        async provision() {
          return {
            containerId: "docker-abc",
            hostPort: 49001,
            network: "app-net-x",
            nodeHost: "10.30.1.5",
          };
        },
      } as never);
      let captured: { hostname: string; extraHostnames?: string[] } | undefined;
      await executeContainerProvision(
        job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
        {
          provider,
          store,
          listVerifiedAppHostnames: async (appId) => {
            expect(appId).toBe(ROW.appId); // looked up by the app, not the container
            return ["elocute.fun", "www.elocute.fun"];
          },
          onRouteAdded: async (r) => {
            captured = r;
          },
        },
      );
      expect(captured?.hostname).toMatch(/\.apps\.elizacloud\.ai$/);
      expect(captured?.extraHostnames).toEqual(["elocute.fun", "www.elocute.fun"]);
    });
  });

  test("a custom-domain lookup failure never fails the deploy (route still added, no extras)", async () => {
    await withBase("apps.elizacloud.ai", async () => {
      const { events, store } = fakeStore();
      const { provider } = fakeProvider({
        async provision() {
          return {
            containerId: "docker-abc",
            hostPort: 49001,
            network: "app-net-x",
            nodeHost: "10.30.1.5",
          };
        },
      } as never);
      let captured: { extraHostnames?: string[] } | undefined;
      await executeContainerProvision(
        job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
        {
          provider,
          store,
          listVerifiedAppHostnames: async () => {
            throw new Error("domains db unavailable");
          },
          onRouteAdded: async (r) => {
            captured = r;
          },
        },
      );
      expect(captured?.extraHostnames).toEqual([]); // degraded gracefully
      expect(events.find((e) => e.op === "running")).toBeDefined(); // deploy still succeeded
    });
  });

  test("delete removes the route (best-effort)", async () => {
    await withBase("apps.elizacloud.ai", async () => {
      const { store } = fakeStore();
      const { provider } = fakeProvider();
      const removed: string[] = [];
      await executeContainerDelete(job({ containerId: "container-1", organizationId: "org-1" }), {
        provider,
        store,
        onRouteRemoved: async (r) => {
          removed.push(r.hostname);
        },
      });
      expect(removed).toHaveLength(1);
      expect(removed[0]).toMatch(/\.apps\.elizacloud\.ai$/);
    });
  });

  test("delete still marks the container deleted when route removal fails", async () => {
    await withBase("apps.elizacloud.ai", async () => {
      const { events, store } = fakeStore();
      const { provider } = fakeProvider();
      await executeContainerDelete(job({ containerId: "container-1", organizationId: "org-1" }), {
        provider,
        store,
        onRouteRemoved: async () => {
          throw new Error("caddy admin unavailable");
        },
      });

      expect(events).toContainEqual({ op: "deleted", id: "container-1" });
    });
  });

  test("no base domain -> no route call (ingress not configured)", async () => {
    await withBase(undefined, async () => {
      const { store } = fakeStore();
      const { provider } = fakeProvider();
      let called = false;
      await executeContainerProvision(
        job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
        {
          provider,
          store,
          onRouteAdded: async () => {
            called = true;
          },
        },
      );
      expect(called).toBe(false);
    });
  });
});
