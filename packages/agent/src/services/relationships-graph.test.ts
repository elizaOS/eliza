/**
 * Unit coverage for resolveRelationshipsGraphService: on-demand enable,
 * duck-typed graph-method checks, owner-resolver wiring, and identity of the
 * core re-exports. Drives the real module against in-memory runtime and
 * service stand-ins — no mocks of the module under test.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  createNativeRelationshipsGraphService as coreCreateNativeRelationshipsGraphService,
  getMemoriesForCluster as coreGetMemoriesForCluster,
  searchMemoriesForCluster as coreSearchMemoriesForCluster,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  createNativeRelationshipsGraphService,
  getMemoriesForCluster,
  resolveRelationshipsGraphService,
  searchMemoriesForCluster,
} from "./relationships-graph.ts";

const GRAPH_METHODS = [
  "getGraphSnapshot",
  "getPersonDetail",
  "getCandidateMerges",
  "acceptMerge",
  "rejectMerge",
  "proposeMerge",
] as const;

const OWNER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

type CallLog = string[];

type GraphStandIn = Record<string, unknown> & {
  setGraphResolvers?: (resolvers: {
    resolveOwnerEntityId: (runtime: IAgentRuntime) => Promise<string | null>;
    fetchConfiguredOwnerName: () => Promise<string | null>;
  }) => void;
};

function graphService(extras: Record<string, unknown> = {}): GraphStandIn {
  const service: GraphStandIn = {};
  for (const method of GRAPH_METHODS) {
    service[method] = async () => undefined;
  }
  return Object.assign(service, extras);
}

function makeRuntime(options: {
  service: unknown;
  isRelationshipsEnabled?: unknown;
  enableRelationships?: unknown;
  getSetting?: (key: string) => unknown;
  callLog?: CallLog;
}): IAgentRuntime {
  const callLog = options.callLog;
  const runtime = {
    getService: (name: string) => {
      callLog?.push(`getService:${name}`);
      return options.service;
    },
    getSetting:
      options.getSetting ??
      ((key: string) =>
        key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ID : undefined),
  } as Record<string, unknown>;

  if ("isRelationshipsEnabled" in options) {
    runtime.isRelationshipsEnabled = options.isRelationshipsEnabled;
  }
  if ("enableRelationships" in options) {
    runtime.enableRelationships = options.enableRelationships;
  }

  return runtime as unknown as IAgentRuntime;
}

describe("relationships-graph re-exports", () => {
  it("re-exports createNativeRelationshipsGraphService from @elizaos/core", () => {
    expect(createNativeRelationshipsGraphService).toBe(
      coreCreateNativeRelationshipsGraphService,
    );
    expect(typeof createNativeRelationshipsGraphService).toBe("function");
  });

  it("re-exports getMemoriesForCluster from @elizaos/core", () => {
    expect(getMemoriesForCluster).toBe(coreGetMemoriesForCluster);
    expect(typeof getMemoriesForCluster).toBe("function");
  });

  it("re-exports searchMemoriesForCluster from @elizaos/core", () => {
    expect(searchMemoriesForCluster).toBe(coreSearchMemoriesForCluster);
    expect(typeof searchMemoriesForCluster).toBe("function");
  });
});

describe("resolveRelationshipsGraphService", () => {
  it("returns the relationships service when it implements every graph method", async () => {
    const service = graphService();
    const resolved = await resolveRelationshipsGraphService(
      makeRuntime({ service }),
    );
    expect(resolved).toBe(service);
  });

  it("asks getService for the relationships service name", async () => {
    const callLog: CallLog = [];
    await resolveRelationshipsGraphService(
      makeRuntime({ service: graphService(), callLog }),
    );
    expect(callLog).toEqual(["getService:relationships"]);
  });

  it("returns null when getService returns null", async () => {
    await expect(
      resolveRelationshipsGraphService(makeRuntime({ service: null })),
    ).resolves.toBeNull();
  });

  it("returns null when getService returns undefined", async () => {
    await expect(
      resolveRelationshipsGraphService(makeRuntime({ service: undefined })),
    ).resolves.toBeNull();
  });

  it("returns null for a primitive getService result", async () => {
    await expect(
      resolveRelationshipsGraphService(
        makeRuntime({ service: "relationships" }),
      ),
    ).resolves.toBeNull();
    await expect(
      resolveRelationshipsGraphService(makeRuntime({ service: 0 })),
    ).resolves.toBeNull();
    await expect(
      resolveRelationshipsGraphService(makeRuntime({ service: false })),
    ).resolves.toBeNull();
  });

  it("returns null for an empty object that has none of the graph methods", async () => {
    await expect(
      resolveRelationshipsGraphService(makeRuntime({ service: {} })),
    ).resolves.toBeNull();
  });

  it("returns null when any required graph method is missing", async () => {
    for (const missing of GRAPH_METHODS) {
      const service = graphService();
      delete service[missing];
      await expect(
        resolveRelationshipsGraphService(makeRuntime({ service })),
      ).resolves.toBeNull();
    }
  });

  it("returns null when a required graph method is present but not a function", async () => {
    const service = graphService({ getPersonDetail: "not-a-function" });
    await expect(
      resolveRelationshipsGraphService(makeRuntime({ service })),
    ).resolves.toBeNull();
  });

  it("accepts graph methods inherited from a prototype", async () => {
    class PrototypeGraph {
      async getGraphSnapshot() {
        return undefined;
      }
      async getPersonDetail() {
        return undefined;
      }
      async getCandidateMerges() {
        return undefined;
      }
      async acceptMerge() {
        return undefined;
      }
      async rejectMerge() {
        return undefined;
      }
      async proposeMerge() {
        return undefined;
      }
    }
    const service = new PrototypeGraph();
    const resolved = await resolveRelationshipsGraphService(
      makeRuntime({ service }),
    );
    expect(resolved).toBe(service);
  });

  it("does not enable relationships when isRelationshipsEnabled is absent", async () => {
    const callLog: CallLog = [];
    let enabled = false;
    await resolveRelationshipsGraphService(
      makeRuntime({
        service: graphService(),
        enableRelationships: async () => {
          enabled = true;
          callLog.push("enable");
        },
        callLog,
      }),
    );
    expect(enabled).toBe(false);
    expect(callLog).toEqual(["getService:relationships"]);
  });

  it("does not enable relationships when they are already enabled", async () => {
    const callLog: CallLog = [];
    let enabled = false;
    await resolveRelationshipsGraphService(
      makeRuntime({
        service: graphService(),
        isRelationshipsEnabled: () => true,
        enableRelationships: async () => {
          enabled = true;
          callLog.push("enable");
        },
        callLog,
      }),
    );
    expect(enabled).toBe(false);
    expect(callLog).toEqual(["getService:relationships"]);
  });

  it("awaits enableRelationships before getService when the feature is disabled", async () => {
    const callLog: CallLog = [];
    const service = graphService();
    const resolved = await resolveRelationshipsGraphService(
      makeRuntime({
        service,
        isRelationshipsEnabled: () => false,
        enableRelationships: async () => {
          callLog.push("enable");
        },
        callLog,
      }),
    );
    expect(callLog).toEqual(["enable", "getService:relationships"]);
    expect(resolved).toBe(service);
  });

  it("does not call enableRelationships when that property is not a function", async () => {
    const callLog: CallLog = [];
    await resolveRelationshipsGraphService(
      makeRuntime({
        service: graphService(),
        isRelationshipsEnabled: () => false,
        enableRelationships: true,
        callLog,
      }),
    );
    expect(callLog).toEqual(["getService:relationships"]);
  });

  it("does not treat a non-function isRelationshipsEnabled as a disable signal", async () => {
    const callLog: CallLog = [];
    let enabled = false;
    await resolveRelationshipsGraphService(
      makeRuntime({
        service: graphService(),
        isRelationshipsEnabled: false,
        enableRelationships: async () => {
          enabled = true;
          callLog.push("enable");
        },
        callLog,
      }),
    );
    expect(enabled).toBe(false);
    expect(callLog).toEqual(["getService:relationships"]);
  });

  it("propagates enableRelationships rejection and never calls getService", async () => {
    const callLog: CallLog = [];
    await expect(
      resolveRelationshipsGraphService(
        makeRuntime({
          service: graphService(),
          isRelationshipsEnabled: () => false,
          enableRelationships: async () => {
            callLog.push("enable");
            throw new Error("enable failed");
          },
          callLog,
        }),
      ),
    ).rejects.toThrow("enable failed");
    expect(callLog).toEqual(["enable"]);
  });

  it("wires setGraphResolvers with owner resolvers that hit the real owner-entity path", async () => {
    let captured:
      | {
          resolveOwnerEntityId: (
            runtime: IAgentRuntime,
          ) => Promise<string | null>;
          fetchConfiguredOwnerName: () => Promise<string | null>;
        }
      | undefined;
    const service = graphService({
      setGraphResolvers: (resolvers: {
        resolveOwnerEntityId: (
          runtime: IAgentRuntime,
        ) => Promise<string | null>;
        fetchConfiguredOwnerName: () => Promise<string | null>;
      }) => {
        captured = resolvers;
      },
    });

    const resolved = await resolveRelationshipsGraphService(
      makeRuntime({ service }),
    );
    expect(resolved).toBe(service);
    expect(captured).toBeDefined();
    if (captured === undefined) {
      throw new Error("setGraphResolvers was not called");
    }

    const ownerRuntime = makeRuntime({ service: null });
    await expect(captured.resolveOwnerEntityId(ownerRuntime)).resolves.toBe(
      OWNER_ID,
    );

    const ownerName = await captured.fetchConfiguredOwnerName();
    expect(ownerName === null || typeof ownerName === "string").toBe(true);
  });

  it("still returns the service when setGraphResolvers is absent", async () => {
    const service = graphService();
    expect("setGraphResolvers" in service).toBe(false);
    await expect(
      resolveRelationshipsGraphService(makeRuntime({ service })),
    ).resolves.toBe(service);
  });

  it("still returns the service when setGraphResolvers is not a function", async () => {
    const service = graphService({ setGraphResolvers: "not-a-function" });
    await expect(
      resolveRelationshipsGraphService(makeRuntime({ service })),
    ).resolves.toBe(service);
  });
});
