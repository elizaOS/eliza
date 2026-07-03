import type {
  AgentRuntime,
  Service,
  SubAgentCredentialBridge,
  SubAgentCredentialScope,
} from "@elizaos/core";
import {
  SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE,
  SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
  SUB_AGENT_CREDENTIAL_PARENT_CAPABILITY_SERVICE,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { registerSubAgentCredentialBridge } from "./sub-agent-credential-bridge-wiring.ts";

type ServiceClassLike = {
  serviceType: string;
  start: (runtime: AgentRuntime) => Promise<Service>;
};

/**
 * Minimal AgentRuntime fake that mimics the essential service lifecycle:
 * registerService stores the class, getServiceLoadPromise force-starts it, and
 * getService returns the started instance synchronously. `seedAcp` controls the
 * parent-vs-sandboxed gate.
 */
function makeFakeRuntime(opts: { seedAcp: boolean }): {
  runtime: AgentRuntime;
  registeredPlugins: Array<{ name?: string }>;
} {
  const classes = new Map<string, ServiceClassLike>();
  const started = new Map<string, Service>();
  const registeredPlugins: Array<{ name?: string }> = [];
  if (opts.seedAcp) {
    // A parent runtime has the orchestrator's subprocess service registered.
    classes.set(SUB_AGENT_CREDENTIAL_PARENT_CAPABILITY_SERVICE, {
      serviceType: SUB_AGENT_CREDENTIAL_PARENT_CAPABILITY_SERVICE,
      start: async () => ({}) as Service,
    });
  }
  const runtime = {
    hasService: (name: string) => classes.has(name) || started.has(name),
    registerService: async (cls: ServiceClassLike) => {
      classes.set(cls.serviceType, cls);
    },
    getServiceLoadPromise: async (name: string) => {
      const existing = started.get(name);
      if (existing) return existing;
      const cls = classes.get(name);
      if (!cls) throw new Error(`no service ${name}`);
      const instance = await cls.start(runtime as AgentRuntime);
      started.set(name, instance);
      return instance;
    },
    getService: <T>(name: string) => (started.get(name) ?? null) as T | null,
    registerPlugin: async (plugin: { name?: string }) => {
      registeredPlugins.push(plugin);
    },
  } as unknown as AgentRuntime;
  return { runtime, registeredPlugins };
}

describe("registerSubAgentCredentialBridge — parent runtime", () => {
  it("registers the bridge under both service names and the actions plugin", async () => {
    const { runtime, registeredPlugins } = makeFakeRuntime({ seedAcp: true });

    await registerSubAgentCredentialBridge(runtime);

    const adapter = runtime.getService<
      Service & { requestCredentials: unknown }
    >(SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE);
    const bridge = runtime.getService<Service & SubAgentCredentialBridge>(
      SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
    );
    expect(adapter).not.toBeNull();
    expect(bridge).not.toBeNull();
    expect(typeof adapter?.requestCredentials).toBe("function");
    expect(typeof bridge?.declareScope).toBe("function");
    expect(typeof bridge?.tunnelCredential).toBe("function");

    expect(
      registeredPlugins.some((p) => p.name === "sub-agent-credentials"),
    ).toBe(true);
  });

  it("resolves a real bridge: declareScope mints a scope and a tunnel round-trips through the registered service", async () => {
    const { runtime } = makeFakeRuntime({ seedAcp: true });
    await registerSubAgentCredentialBridge(runtime);

    const bridge = runtime.getService<Service & SubAgentCredentialBridge>(
      SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
    );
    const adapter = runtime.getService<
      Service & {
        tryRetrieveCredential: (input: {
          childSessionId: string;
          key: string;
          scopedToken: string;
        }) => Promise<{ status: string; value?: string }>;
      }
    >(SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE);

    if (!bridge || !adapter) throw new Error("bridge not registered on parent");

    const scope: SubAgentCredentialScope = await bridge.declareScope({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
    });
    expect(scope.credentialScopeId).toMatch(/^cred_scope_[0-9a-f]{16}$/);
    expect(scope.sensitiveRequestIds).toEqual([]);

    await bridge.tunnelCredential({
      childSessionId: "pty-1-abc",
      credentialScopeId: scope.credentialScopeId,
      key: "OPENAI_API_KEY",
      value: "sk-secret",
    });

    const outcome = await adapter.tryRetrieveCredential({
      childSessionId: "pty-1-abc",
      key: "OPENAI_API_KEY",
      scopedToken: scope.scopedToken,
    });
    expect(outcome).toEqual({ status: "ready", value: "sk-secret" });
  });

  it("is idempotent — a second call does not re-register the plugin", async () => {
    const { runtime, registeredPlugins } = makeFakeRuntime({ seedAcp: true });
    await registerSubAgentCredentialBridge(runtime);
    await registerSubAgentCredentialBridge(runtime);
    expect(
      registeredPlugins.filter((p) => p.name === "sub-agent-credentials"),
    ).toHaveLength(1);
  });
});

describe("registerSubAgentCredentialBridge — sandboxed child runtime", () => {
  it("registers nothing when the ACP subprocess service is absent (degrades to 503 path)", async () => {
    const { runtime, registeredPlugins } = makeFakeRuntime({ seedAcp: false });
    const registerSpy = vi.spyOn(runtime, "registerService");

    await registerSubAgentCredentialBridge(runtime);

    expect(registerSpy).not.toHaveBeenCalled();
    expect(
      runtime.getService(SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE),
    ).toBeNull();
    expect(runtime.getService(SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE)).toBeNull();
    expect(registeredPlugins).toHaveLength(0);
  });
});
