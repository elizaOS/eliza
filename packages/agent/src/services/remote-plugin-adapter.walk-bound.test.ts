/**
 * Fail-closed provenance canonicalize walk. Origin develop
 * 3775f57b4e51c7fe6e5a1bb76aeaf00b487b2cbc recurses without a cycle/depth
 * bound, so a cyclic or over-deep remote module RangeError'd the agent
 * during requireProvenanceDigestMatch. This suite is the overlay proof, and
 * also pins the three properties the bound must not break: an acyclic DAG that
 * repeats a shared reference still hashes exactly like the unbounded walker,
 * width is charged from the declared length/key count before any allocation,
 * and the walk reflects on descriptors only — no [[Get]], no [[Has]], no
 * accessor invocation on untrusted remote module data.
 */
import { createHash } from "node:crypto";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  CapabilityError,
  type ElizaCapabilityRouter,
  type IAgentRuntime,
  type RemotePluginModuleManifest,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { syncRemoteCapabilityPlugins } from "./remote-plugin-adapter.ts";

function makeRouter(): ElizaCapabilityRouter {
  const unavailable = async () => {
    throw new CapabilityError({
      code: "CAPABILITY_UNAVAILABLE",
      message: "capability unavailable in walk-bound test router",
      capability: "plugin",
    });
  };
  return {
    environment: "server",
    availability: async () => ({
      environment: "server",
      available: true,
      capabilities: {
        fs: false,
        pty: false,
        git: false,
        model: false,
        plugin: true,
      },
    }),
    fs: {
      list: unavailable,
      readText: unavailable,
      writeText: unavailable,
    },
    pty: { runCommand: unavailable },
    git: {
      status: unavailable,
      diff: unavailable,
      commandRun: unavailable,
    },
    model: { status: unavailable },
    plugin: {
      listModules: unavailable,
      invokeAction: unavailable,
      getProvider: unavailable,
      callRoute: unavailable,
      getAsset: unavailable,
      shouldRunEvaluator: unavailable,
      prepareEvaluator: unavailable,
      promptEvaluator: unavailable,
      processEvaluator: unavailable,
      shouldRunResponseHandlerEvaluator: unavailable,
      evaluateResponseHandlerEvaluator: unavailable,
      shouldRunResponseHandlerFieldEvaluator: unavailable,
      parseResponseHandlerFieldEvaluator: unavailable,
      handleResponseHandlerFieldEvaluator: unavailable,
      callLifecycle: unavailable,
      handleEvent: unavailable,
      invokeModel: unavailable,
      callService: unavailable,
      callAppBridge: unavailable,
    },
  };
}

function makeRuntime(router: ElizaCapabilityRouter): IAgentRuntime {
  return {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    character: { name: "Remote Plugin Walk Bound" },
    getService: (serviceType: string) =>
      serviceType === CAPABILITY_ROUTER_SERVICE_TYPE ? router : null,
    registerPlugin: async () => {},
    reloadPlugin: async () => {},
    unloadPlugin: async () => null,
    getAllPluginOwnership: () => [],
    hasService: (serviceType: string) =>
      serviceType === CAPABILITY_ROUTER_SERVICE_TYPE,
    getServiceLoadPromise: async () => router as never,
  } as Partial<IAgentRuntime> as IAgentRuntime;
}

function baseModule(): RemotePluginModuleManifest {
  return {
    id: "remote-demo",
    name: "@remote/demo",
    version: "1.0.0",
    capabilityEndpointId: "trusted-cloud",
    provenance: {
      issuer: "eliza-cloud-build",
      subject: "cloud://agents/trusted-cloud/modules/remote-demo",
      digestSha256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      signatureAlgorithm: "ed25519",
      signature: "not-verified-in-this-suite",
    },
  };
}

const digestPolicy = {
  allowedEndpointIds: ["trusted-cloud"],
  requireEndpointId: true,
  requireProvenanceDigestMatch: true,
};

/**
 * Independent reimplementation of the pre-bound canonicalizer: sort own
 * enumerable string keys, drop `undefined` values, expand every reference at
 * every path it occurs. Used as the compatibility oracle — a module whose
 * provenance digest is computed this way must still be trusted by the bounded
 * walk.
 */
function legacyCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, legacyCanonical(entry)]),
    );
  }
  return value;
}

function legacyProvenanceDigest(module: RemotePluginModuleManifest): string {
  const {
    capabilityEndpointId: _endpointId,
    provenance: _provenance,
    ...rest
  } = module;
  return createHash("sha256")
    .update(JSON.stringify(legacyCanonical(rest)), "utf8")
    .digest("hex");
}

/** A module carrying `nest`, with a provenance digest that already matches. */
function moduleWithNest(nest: unknown): RemotePluginModuleManifest {
  const module = { ...baseModule(), nest } as RemotePluginModuleManifest;
  const provenance = module.provenance;
  if (!provenance) throw new Error("baseModule must carry provenance");
  return {
    ...module,
    provenance: { ...provenance, digestSha256: legacyProvenanceDigest(module) },
  };
}

const walkBoundRejection = {
  code: "CAPABILITY_UNAVAILABLE",
  capability: "plugin",
  method: "plugin.modules.list",
  message: 'Remote plugin module "remote-demo" provenance walk exceeded bound.',
  details: {
    trustDecision: { reason: "provenance-walk-bound", trusted: false },
  },
};

describe("remote plugin provenance canonicalize walk bound", () => {
  it("fail-closes a cyclic remote module instead of overflowing the stack", async () => {
    const runtime = makeRuntime(makeRouter());
    const module = baseModule() as RemotePluginModuleManifest & {
      nest?: unknown;
    };
    const cycle: Record<string, unknown> = { id: "loop" };
    cycle.self = cycle;
    module.nest = cycle;

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [module],
        trustPolicy: digestPolicy,
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "plugin",
      method: "plugin.modules.list",
      message:
        'Remote plugin module "remote-demo" provenance walk exceeded bound.',
      details: {
        trustDecision: {
          moduleId: "remote-demo",
          pluginName: "@remote/demo",
          endpointId: "trusted-cloud",
          trusted: false,
          reason: "provenance-walk-bound",
        },
      },
    });
  });

  it("fail-closes an over-deep remote module instead of overflowing the stack", async () => {
    const runtime = makeRuntime(makeRouter());
    let deep: unknown = "leaf";
    for (let i = 0; i < 64; i += 1) {
      deep = { n: deep };
    }
    const module = {
      ...baseModule(),
      nest: deep,
    };

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [module],
        trustPolicy: digestPolicy,
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      message:
        'Remote plugin module "remote-demo" provenance walk exceeded bound.',
      details: {
        trustDecision: {
          reason: "provenance-walk-bound",
          trusted: false,
        },
      },
    });
  });

  it("still rejects an honest finite module whose digest does not match", async () => {
    const runtime = makeRuntime(makeRouter());
    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [baseModule()],
        trustPolicy: digestPolicy,
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      message:
        'Remote plugin module "remote-demo" provenance digest does not match module contents.',
      details: {
        trustDecision: {
          reason: "invalid-provenance-digest",
          trusted: false,
        },
      },
    });
  });
});

describe("remote plugin provenance repeated-reference compatibility", () => {
  it("trusts an acyclic DAG that repeats a shared reference", async () => {
    const runtime = makeRuntime(makeRouter());
    const shared = { label: "shared", values: [1, 2, 3] };
    const module = moduleWithNest({
      left: shared,
      right: shared,
      deep: { shared },
    });

    const result = await syncRemoteCapabilityPlugins(runtime, {
      modules: [module],
      trustPolicy: digestPolicy,
    });

    expect(result.trustDecisions).toMatchObject([
      { moduleId: "remote-demo", trusted: true, reason: "allowed" },
    ]);
  });

  it("trusts a repeated shared array reference at sibling paths", async () => {
    const runtime = makeRuntime(makeRouter());
    const shared = ["a", "b"];
    const module = moduleWithNest([shared, shared, [shared]]);

    const result = await syncRemoteCapabilityPlugins(runtime, {
      modules: [module],
      trustPolicy: digestPolicy,
    });

    expect(result.trustDecisions).toMatchObject([
      { trusted: true, reason: "allowed" },
    ]);
  });

  it("still fail-closes when the repeated reference is a real back edge", async () => {
    const runtime = makeRuntime(makeRouter());
    const shared: Record<string, unknown> = { label: "shared" };
    const cycle: Record<string, unknown> = { shared };
    shared.parent = cycle;

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          { ...baseModule(), nest: cycle } as RemotePluginModuleManifest,
        ],
        trustPolicy: digestPolicy,
      }),
    ).rejects.toMatchObject(walkBoundRejection);
  });
});

describe("remote plugin provenance width bound", () => {
  // The stripped module carries id/name/version plus `nest`: four slots. The
  // node budget is 4096, so a 4092-entry array lands exactly on the bound.
  const EXACT_WIDTH = 4096 - 4;

  it("accepts a primitive array exactly on the node bound", async () => {
    const runtime = makeRuntime(makeRouter());
    const module = moduleWithNest(
      Array.from({ length: EXACT_WIDTH }, (_, index) => index),
    );

    const result = await syncRemoteCapabilityPlugins(runtime, {
      modules: [module],
      trustPolicy: digestPolicy,
    });

    expect(result.trustDecisions).toMatchObject([
      { trusted: true, reason: "allowed" },
    ]);
  });

  it("fail-closes a primitive array one slot past the node bound", async () => {
    const runtime = makeRuntime(makeRouter());
    const module = moduleWithNest(
      Array.from({ length: EXACT_WIDTH + 1 }, (_, index) => index),
    );

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [module],
        trustPolicy: digestPolicy,
      }),
    ).rejects.toMatchObject(walkBoundRejection);
  });

  it("accepts an object exactly on the node bound", async () => {
    const runtime = makeRuntime(makeRouter());
    const module = moduleWithNest(
      Object.fromEntries(
        Array.from({ length: EXACT_WIDTH }, (_, index) => [`k${index}`, index]),
      ),
    );

    const result = await syncRemoteCapabilityPlugins(runtime, {
      modules: [module],
      trustPolicy: digestPolicy,
    });

    expect(result.trustDecisions).toMatchObject([
      { trusted: true, reason: "allowed" },
    ]);
  });

  it("fail-closes an object one key past the node bound", async () => {
    const runtime = makeRuntime(makeRouter());
    const module = moduleWithNest(
      Object.fromEntries(
        Array.from({ length: EXACT_WIDTH + 1 }, (_, index) => [
          `k${index}`,
          index,
        ]),
      ),
    );

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [module],
        trustPolicy: digestPolicy,
      }),
    ).rejects.toMatchObject(walkBoundRejection);
  });

  it("charges declared length, so a huge sparse array never allocates", async () => {
    const runtime = makeRuntime(makeRouter());
    const sparse = new Array(4_000_000);
    const started = Date.now();

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          { ...baseModule(), nest: sparse } as RemotePluginModuleManifest,
        ],
        trustPolicy: digestPolicy,
      }),
    ).rejects.toMatchObject(walkBoundRejection);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("charges every key of a huge primitive-width object", async () => {
    const runtime = makeRuntime(makeRouter());
    const wide = Object.fromEntries(
      Array.from({ length: 200_000 }, (_, index) => [`k${index}`, index]),
    );

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          { ...baseModule(), nest: wide } as RemotePluginModuleManifest,
        ],
        trustPolicy: digestPolicy,
      }),
    ).rejects.toMatchObject(walkBoundRejection);
  });
});

describe("remote plugin provenance hostile-value reflection", () => {
  it("hashes a proxied module value with zero get/has trap calls", async () => {
    const runtime = makeRuntime(makeRouter());
    const trapCalls = { get: 0, has: 0 };
    const probed = new Proxy(
      { plain: "value", nested: { list: [1, 2, 3] } },
      {
        get(inner, key, receiver) {
          trapCalls.get += 1;
          return Reflect.get(inner, key, receiver);
        },
        has(inner, key) {
          trapCalls.has += 1;
          return Reflect.has(inner, key);
        },
      },
    );
    const module = moduleWithNest(probed);
    // The oracle digest above walks with [[Get]]; only the bounded walk under
    // test is measured.
    trapCalls.get = 0;
    trapCalls.has = 0;

    const result = await syncRemoteCapabilityPlugins(runtime, {
      modules: [module],
      trustPolicy: digestPolicy,
    });

    expect(result.trustDecisions).toMatchObject([
      { trusted: true, reason: "allowed" },
    ]);
    expect(trapCalls).toEqual({ get: 0, has: 0 });
  });

  it("refuses a proxied accessor property without invoking it", async () => {
    const runtime = makeRuntime(makeRouter());
    const trapCalls = { get: 0, has: 0, getter: 0 };
    const probed = new Proxy(
      {
        plain: "value",
        get accessorFree() {
          trapCalls.getter += 1;
          return "never-read";
        },
      },
      {
        get(inner, key, receiver) {
          trapCalls.get += 1;
          return Reflect.get(inner, key, receiver);
        },
        has(inner, key) {
          trapCalls.has += 1;
          return Reflect.has(inner, key);
        },
      },
    );

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          { ...baseModule(), nest: probed } as RemotePluginModuleManifest,
        ],
        trustPolicy: digestPolicy,
      }),
    ).rejects.toMatchObject(walkBoundRejection);
    expect(trapCalls).toEqual({ get: 0, has: 0, getter: 0 });
  });

  it("fail-closes a revoked proxy instead of leaking a raw TypeError", async () => {
    const runtime = makeRuntime(makeRouter());
    const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
    revoke();

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          { ...baseModule(), nest: proxy } as RemotePluginModuleManifest,
        ],
        trustPolicy: digestPolicy,
      }),
    ).rejects.toMatchObject(walkBoundRejection);
  });

  it("fail-closes a hostile proxy whose reflection traps throw", async () => {
    const runtime = makeRuntime(makeRouter());
    const hostile = new Proxy(
      { a: 1 },
      {
        ownKeys() {
          throw new TypeError("hostile ownKeys");
        },
      },
    );

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          { ...baseModule(), nest: hostile } as RemotePluginModuleManifest,
        ],
        trustPolicy: digestPolicy,
      }),
    ).rejects.toMatchObject(walkBoundRejection);
  });

  it("fail-closes a hostile proxy whose descriptor trap throws", async () => {
    const runtime = makeRuntime(makeRouter());
    const hostile = new Proxy(
      { a: 1 },
      {
        getOwnPropertyDescriptor() {
          throw new TypeError("hostile descriptor");
        },
      },
    );

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          { ...baseModule(), nest: hostile } as RemotePluginModuleManifest,
        ],
        trustPolicy: digestPolicy,
      }),
    ).rejects.toMatchObject(walkBoundRejection);
  });

  it("refuses an accessor property instead of invoking it", async () => {
    const runtime = makeRuntime(makeRouter());
    let invoked = 0;
    const accessor = {};
    Object.defineProperty(accessor, "trap", {
      enumerable: true,
      configurable: true,
      get() {
        invoked += 1;
        return "should-never-be-read";
      },
    });

    await expect(
      syncRemoteCapabilityPlugins(runtime, {
        modules: [
          { ...baseModule(), nest: accessor } as RemotePluginModuleManifest,
        ],
        trustPolicy: digestPolicy,
      }),
    ).rejects.toMatchObject(walkBoundRejection);
    expect(invoked).toBe(0);
  });
});
