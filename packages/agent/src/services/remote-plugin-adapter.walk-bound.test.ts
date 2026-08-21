/**
 * Fail-closed provenance canonicalize walk. Origin develop
 * 3775f57b4e51c7fe6e5a1bb76aeaf00b487b2cbc recurses without a cycle/depth
 * bound, so a cyclic or over-deep remote module RangeError'd the agent
 * during requireProvenanceDigestMatch. This suite is the overlay proof.
 */
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
