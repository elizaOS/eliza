/** Exercises container lifecycle transitions through deterministic provider and store seams. */
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
  hostContainerId: "docker-immutable-1",
};

function fakeStore(row: AppContainerRow | null = ROW) {
  const events: Array<{ op: string; id: string; info?: unknown }> = [];
  const slotEvents: Array<{ op: "claim" | "rollback"; nodeId: string }> = [];
  const store: AppContainerStore = {
    async getById() {
      return row;
    },
    async findDeletingByOrganization() {
      return row ? [row] : [];
    },
    async claimNodeSlot(_id, _organizationId, nodeId) {
      slotEvents.push({ op: "claim", nodeId });
      return "claimed";
    },
    async rollbackNodeSlotClaim(_id, _organizationId, nodeId) {
      slotEvents.push({ op: "rollback", nodeId });
      return true;
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
    async markCleanupRequired(id, error) {
      events.push({ op: "cleanup-required", id, info: error });
    },
  };
  return { events, slotEvents, store };
}

function fakeProvider(over: Partial<Record<keyof AppContainerProvider, unknown>> = {}) {
  const calls: Array<{ op: string; arg: unknown }> = [];
  const provider = {
    targetNodeId: "node-1",
    async provision(params: unknown): Promise<ProvisionedAppContainer> {
      calls.push({ op: "provision", arg: params });
      return {
        containerId: "docker-abc",
        hostPort: 49001,
        network: "app-net-x",
        nodeId: "node-1",
        nodeHost: "node.example.test",
      };
    },
    async delete(name: string) {
      calls.push({ op: "delete", arg: name });
    },
    async deleteById(hostContainerId: string, name: string) {
      calls.push({ op: "deleteById", arg: { hostContainerId, name } });
    },
    async deletePrimaryById(hostContainerId: string) {
      calls.push({ op: "deletePrimaryById", arg: hostContainerId });
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

const job = (data: unknown, organizationId?: string) => {
  const payloadOrganizationId =
    typeof data === "object" &&
    data !== null &&
    typeof Reflect.get(data, "organizationId") === "string"
      ? (Reflect.get(data, "organizationId") as string)
      : "org-1";
  return {
    id: "job-1",
    data,
    organization_id: organizationId ?? payloadOrganizationId,
  };
};

describe("executeContainerProvision", () => {
  test("builds input from the row, provisions, and marks running", async () => {
    const { events, slotEvents, store } = fakeStore();
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
        info: {
          hostContainerId: "docker-abc",
          hostPort: 49001,
          network: "app-net-x",
          nodeHost: "node.example.test",
        },
      },
    ]);
    expect(slotEvents).toEqual([{ op: "claim", nodeId: "node-1" }]);
  });

  test("a worker retry may continue only with the same idempotent slot claim", async () => {
    const { events, store } = fakeStore();
    store.claimNodeSlot = async () => "already-claimed";
    const { calls, provider } = fakeProvider();

    await executeContainerProvision(
      job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
      { provider, store },
    );

    expect(calls.some((call) => call.op === "provision")).toBe(true);
    expect(events.some((event) => event.op === "running")).toBe(true);
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
        markAppDeployed: async (appId, _generation, url) => {
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

  test("a stale container generation performs no provider or state mutation", async () => {
    const deploymentGeneration = "11111111-1111-4111-8111-111111111111";
    const { events, slotEvents, store } = fakeStore({ ...ROW, deploymentGeneration });
    const { calls, provider } = fakeProvider();

    await executeContainerProvision(
      job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
      {
        provider,
        store,
        isAppDeploymentCurrent: async (_appId, generation) => {
          expect(generation).toBe(deploymentGeneration);
          return false;
        },
      },
    );

    expect(calls).toEqual([]);
    expect(events).toEqual([]);
    expect(slotEvents).toEqual([]);
  });

  test("a provision job whose generation disagrees with its row performs no mutation", async () => {
    const deploymentGeneration = "11111111-1111-4111-8111-111111111111";
    const { events, slotEvents, store } = fakeStore({ ...ROW, deploymentGeneration });
    const { calls, provider } = fakeProvider();

    await executeContainerProvision(
      job({
        containerId: "container-1",
        organizationId: "org-1",
        userId: "user-1",
        deploymentGeneration: "22222222-2222-4222-8222-222222222222",
      }),
      {
        provider,
        store,
        isAppDeploymentCurrent: async () => true,
      },
    );

    expect(calls).toEqual([]);
    expect(events).toEqual([]);
    expect(slotEvents).toEqual([]);
  });

  test("a generated container fails closed when the generation fence is not wired", async () => {
    const deploymentGeneration = "11111111-1111-4111-8111-111111111111";
    const { events, slotEvents, store } = fakeStore({ ...ROW, deploymentGeneration });
    const { calls, provider } = fakeProvider();

    await expect(
      executeContainerProvision(
        job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
        { provider, store },
      ),
    ).rejects.toMatchObject({ code: "APP_DEPLOYMENT_GENERATION_FENCE_MISSING" });

    expect(calls).toEqual([]);
    expect(events).toEqual([]);
    expect(slotEvents).toEqual([]);
  });

  test("a generation that becomes stale during provision is discarded before state mutation", async () => {
    const deploymentGeneration = "11111111-1111-4111-8111-111111111111";
    const { events, slotEvents, store } = fakeStore({ ...ROW, deploymentGeneration });
    const provisionStarted = Promise.withResolvers<void>();
    const releaseProvision = Promise.withResolvers<void>();
    let current = true;
    const { calls, provider } = fakeProvider({
      async provision(params: unknown) {
        calls.push({ op: "provision", arg: params });
        provisionStarted.resolve();
        await releaseProvision.promise;
        return {
          containerId: "docker-stale-1",
          hostPort: 49001,
          network: "app-net-x",
          nodeId: "node-1",
          nodeHost: "node.example.test",
        };
      },
    });

    const execution = executeContainerProvision(
      job({
        containerId: "container-1",
        organizationId: "org-1",
        userId: "user-1",
        deploymentGeneration,
      }),
      { provider, store, isAppDeploymentCurrent: async () => current },
    );
    await provisionStarted.promise;
    current = false;
    releaseProvision.resolve();
    await execution;

    expect(calls.map((call) => call.op)).toEqual(["provision", "deletePrimaryById"]);
    expect(events).toEqual([]);
    expect(slotEvents).toEqual([
      { op: "claim", nodeId: "node-1" },
      { op: "rollback", nodeId: "node-1" },
    ]);
  });

  test("a generation that becomes stale before markRunning discards the primary and slot", async () => {
    const deploymentGeneration = "11111111-1111-4111-8111-111111111111";
    const { events, slotEvents, store } = fakeStore({ ...ROW, deploymentGeneration });
    const { calls, provider } = fakeProvider();
    let currentChecks = 0;

    await executeContainerProvision(
      job({
        containerId: "container-1",
        organizationId: "org-1",
        userId: "user-1",
        deploymentGeneration,
      }),
      {
        provider,
        store,
        isAppDeploymentCurrent: async () => {
          currentChecks += 1;
          return currentChecks < 3;
        },
      },
    );

    expect(currentChecks).toBe(3);
    expect(calls.map((call) => call.op)).toEqual(["provision", "deletePrimaryById"]);
    expect(events).toEqual([]);
    expect(slotEvents).toEqual([
      { op: "claim", nodeId: "node-1" },
      { op: "rollback", nodeId: "node-1" },
    ]);
  });

  test("marks error and rethrows when provisioning fails", async () => {
    const { events, slotEvents, store } = fakeStore();
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
    expect(slotEvents).toEqual([
      { op: "claim", nodeId: "node-1" },
      { op: "rollback", nodeId: "node-1" },
    ]);
  });

  test("create or start failure with unproven removal retains the claimed slot", async () => {
    const { events, slotEvents, store } = fakeStore();
    let containerExists = false;
    const { provider } = fakeProvider({
      async provision() {
        containerExists = true;
        throw new Error("docker start failed");
      },
      async delete() {
        expect(containerExists).toBe(true);
        throw new Error("docker rm failed");
      },
    } as never);

    await expect(
      executeContainerProvision(
        job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
        { provider, store },
      ),
    ).rejects.toThrow("cleanup could not be proven");

    expect(slotEvents).toEqual([{ op: "claim", nodeId: "node-1" }]);
    expect(containerExists).toBe(true);
    expect(events).toEqual([
      {
        op: "cleanup-required",
        id: "container-1",
        info: "docker start failed; Docker absence unproven: docker rm failed",
      },
    ]);
  });

  test("capacity refusal never invokes Docker or fabricates a failed container", async () => {
    const { events, store } = fakeStore();
    store.claimNodeSlot = async () => {
      throw new Error("node capacity unavailable");
    };
    const { calls, provider } = fakeProvider();

    await expect(
      executeContainerProvision(
        job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
        { provider, store },
      ),
    ).rejects.toThrow("node capacity unavailable");

    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  test("a running-state write failure removes Docker before releasing the slot", async () => {
    const { events, slotEvents, store } = fakeStore();
    store.markRunning = async () => {
      throw new Error("status write failed");
    };
    const { calls, provider } = fakeProvider();

    await expect(
      executeContainerProvision(
        job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
        { provider, store },
      ),
    ).rejects.toThrow("status write failed");

    expect(calls.map((call) => call.op)).toEqual(["provision", "delete"]);
    expect(slotEvents).toEqual([
      { op: "claim", nodeId: "node-1" },
      { op: "rollback", nodeId: "node-1" },
    ]);
    expect(events).toEqual([{ op: "error", id: "container-1", info: "status write failed" }]);
  });

  test("failed Docker rollback keeps the slot claimed for retry reconciliation", async () => {
    const { events, slotEvents, store } = fakeStore();
    store.markRunning = async () => {
      throw new Error("status write failed");
    };
    const { provider } = fakeProvider({
      async delete() {
        throw new Error("ssh unavailable");
      },
    });

    await expect(
      executeContainerProvision(
        job({ containerId: "container-1", organizationId: "org-1", userId: "user-1" }),
        { provider, store },
      ),
    ).rejects.toThrow("cleanup could not be proven");

    expect(slotEvents).toEqual([{ op: "claim", nodeId: "node-1" }]);
    expect(events).toEqual([
      {
        op: "cleanup-required",
        id: "container-1",
        info: "status write failed; Docker absence unproven: ssh unavailable",
      },
    ]);
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
    expect(calls.find((c) => c.op === "deleteById")?.arg).toEqual({
      hostContainerId: "docker-immutable-1",
      name: "app-nubilio",
    });
    expect(events).toEqual([{ op: "deleted", id: "container-1" }]);
  });

  test("delete completes the terminal transition when its row is already absent", async () => {
    const { events, store } = fakeStore(null);
    const { calls, provider } = fakeProvider();

    await executeContainerDelete(job({ containerId: "container-1", organizationId: "org-1" }), {
      provider,
      store,
    });

    expect(calls).toEqual([]);
    expect(events).toEqual([{ op: "deleted", id: "container-1" }]);
  });

  test("an org-only legacy job recovers rows already marked for deletion", async () => {
    const { events, store } = fakeStore();
    const { calls, provider } = fakeProvider();

    await executeContainerDelete(job({ organizationId: "org-1" }), {
      provider,
      store,
    });

    expect(calls.find((call) => call.op === "deleteById")?.arg).toEqual({
      hostContainerId: "docker-immutable-1",
      name: "app-nubilio",
    });
    expect(events).toEqual([{ op: "deleted", id: "container-1" }]);
  });

  test("legacy recovery never removes a newer live container through a reused name", async () => {
    const staleDeletingRow = { ...ROW, hostContainerId: undefined };
    const { events, store } = fakeStore(staleDeletingRow);
    const { calls, provider } = fakeProvider();

    await executeContainerDelete(job({ organizationId: "org-1" }), {
      provider,
      store,
    });

    expect(calls.filter((call) => call.op === "delete" || call.op === "deleteById")).toEqual([]);
    expect(events).toEqual([{ op: "deleted", id: "container-1" }]);
  });

  test("a repeated legacy job is an idempotent no-op after recovery", async () => {
    const { events, store } = fakeStore(null);
    const { calls, provider } = fakeProvider();

    await executeContainerDelete(job({ organizationId: "org-1" }), {
      provider,
      store,
    });

    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  test("recovery completes the DB transition when another worker removed Docker first", async () => {
    const { events, store } = fakeStore();
    const { provider } = fakeProvider({
      async delete() {
        throw new Error("No such container: app-nubilio");
      },
    });

    await executeContainerDelete(job({ organizationId: "org-1" }), {
      provider,
      store,
    });

    expect(events).toEqual([{ op: "deleted", id: "container-1" }]);
  });

  test("a valid delete job cannot target another organization's row", async () => {
    const { store } = fakeStore({ ...ROW, organizationId: "org-2" });
    const { calls, provider } = fakeProvider();

    await expect(
      executeContainerDelete(job({ containerId: "container-1", organizationId: "org-1" }), {
        provider,
        store,
      }),
    ).rejects.toThrow("does not own");
    expect(calls).toEqual([]);
  });

  test("rejects an organization-only payload before a foreign tenant lookup", async () => {
    const { events, store } = fakeStore();
    const lookedUpOrganizations: string[] = [];
    store.findDeletingByOrganization = async (organizationId) => {
      lookedUpOrganizations.push(organizationId);
      return [ROW];
    };
    const { calls, provider } = fakeProvider();

    await expect(
      executeContainerDelete(job({ organizationId: "org-foreign" }, "org-owner"), {
        provider,
        store,
      }),
    ).rejects.toMatchObject({ code: "CONTAINER_DELETE_PAYLOAD_ORGANIZATION_MISMATCH" });

    expect(lookedUpOrganizations).toEqual([]);
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  test("rejects a codec-valid payload when its tenant differs from the job row", async () => {
    const { events, store } = fakeStore();
    let containerRead = false;
    store.getById = async () => {
      containerRead = true;
      return ROW;
    };
    const { calls, provider } = fakeProvider();

    await expect(
      executeContainerDelete(
        job({ containerId: "container-1", organizationId: "org-foreign" }, "org-owner"),
        { provider, store },
      ),
    ).rejects.toMatchObject({ code: "CONTAINER_DELETE_PAYLOAD_ORGANIZATION_MISMATCH" });

    expect(containerRead).toBe(false);
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
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
