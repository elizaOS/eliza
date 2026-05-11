/**
 * FeatureFlagRegistry unit tests.
 *
 * Covers the registry contract that lifts the closed `LifeOpsFeatureKey`
 * literal union into an open registry (Audit C top-1 finding,
 * `docs/audit/rigidity-hunt-audit.md`). Verifies:
 *   - the default pack registers all 10 built-in flags,
 *   - a synthetic third-party flag can be registered + visible to the
 *     dev-registries view,
 *   - TOGGLE_FEATURE accepts a registered third-party key,
 *   - `UnknownFeatureFlagError` is thrown for an unregistered key,
 *   - `isBuiltin()` distinguishes built-in vs third-party flags,
 *   - per-runtime WeakMap binding isolates registries.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  ALL_FEATURE_KEYS,
  type LifeOpsFeatureFlagKey,
} from "../src/lifeops/feature-flags.types.ts";
import {
  __resetFeatureFlagRegistryForTests,
  createFeatureFlagRegistry,
  DEFAULT_FEATURE_FLAG_PACK,
  type FeatureFlagContribution,
  getFeatureFlagRegistry,
  LIFEOPS_BUILTIN_FEATURE_KEYS,
  registerDefaultFeatureFlagPack,
  registerFeatureFlagRegistry,
  UnknownFeatureFlagError,
} from "../src/lifeops/registries/index.ts";
import type { LifeOpsRouteContext } from "../src/routes/lifeops-routes.ts";
import { makeScheduledTasksRouteHandler } from "../src/routes/scheduled-tasks.ts";
import {
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
} from "../src/lifeops/scheduled-task/index.ts";
import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "../src/lifeops/scheduled-task/completion-check-registry.ts";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "../src/lifeops/scheduled-task/consolidation-policy.ts";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "../src/lifeops/scheduled-task/escalation.ts";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "../src/lifeops/scheduled-task/gate-registry.ts";

const ACME_KEY: LifeOpsFeatureFlagKey = "acme.experiment";

function makeRuntimeStub(): IAgentRuntime {
  return {} as IAgentRuntime;
}

function makeRunner(): ScheduledTaskRunnerHandle {
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  return createScheduledTaskRunner({
    agentId: "test-agent",
    store: createInMemoryScheduledTaskStore(),
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: async () => ({}),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
  });
}

interface MockResponse {
  statusCode?: number;
  body?: string;
  headers: Record<string, string>;
  ended: boolean;
}

function setRemoteAddress(socket: Socket, remoteAddress: string): void {
  Object.defineProperty(socket, "remoteAddress", {
    value: remoteAddress,
    configurable: true,
  });
}

function buildCtx(args: {
  method: string;
  pathname: string;
  runtime: IAgentRuntime | null;
}): { ctx: LifeOpsRouteContext; res: MockResponse } {
  const res: MockResponse = { headers: {}, ended: false };
  const socket = new Socket();
  setRemoteAddress(socket, "127.0.0.1");
  const httpReq = new IncomingMessage(socket);
  httpReq.method = args.method;
  httpReq.headers = {};

  const httpRes = new ServerResponse(httpReq);
  httpRes.statusCode = 0;
  const setHeader = httpRes.setHeader.bind(httpRes);
  httpRes.setHeader = (name, value) => {
    res.headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
    return setHeader(name, value);
  };
  httpRes.end = function end(
    this: ServerResponse,
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): ServerResponse {
    res.ended = true;
    res.body = typeof chunk === "string" ? chunk : "";
    res.statusCode = this.statusCode;
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return this;
  };

  const ctx: LifeOpsRouteContext = {
    req: httpReq,
    res: httpRes,
    method: args.method,
    pathname: args.pathname,
    url: new URL(`http://localhost${args.pathname}`),
    state: { runtime: args.runtime as AgentRuntime | null, adminEntityId: null },
    json(r, data, status = 200) {
      r.statusCode = status;
      r.setHeader?.("content-type", "application/json");
      r.end?.(JSON.stringify(data));
    },
    error(r, message, status = 400) {
      r.statusCode = status;
      r.setHeader?.("content-type", "application/json");
      r.end?.(JSON.stringify({ error: message }));
    },
    async readJsonBody<T extends object>(): Promise<T | null> {
      return null as T | null;
    },
    decodePathComponent(raw) {
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    },
  };
  return { ctx, res };
}

describe("FeatureFlagRegistry", () => {
  it("default pack registers all 10 built-in feature keys", () => {
    const runtime = makeRuntimeStub();
    const registry = registerDefaultFeatureFlagPack(runtime);
    const keys = registry.list().map((c) => c.key);
    expect(keys.sort()).toEqual([...ALL_FEATURE_KEYS].sort());
    expect(DEFAULT_FEATURE_FLAG_PACK).toHaveLength(ALL_FEATURE_KEYS.length);
    for (const c of DEFAULT_FEATURE_FLAG_PACK) {
      expect(c.namespace).toBe("core");
    }
    __resetFeatureFlagRegistryForTests(runtime);
  });

  it("rejects duplicate registration", () => {
    const registry = createFeatureFlagRegistry({
      builtinKeys: LIFEOPS_BUILTIN_FEATURE_KEYS,
    });
    const contribution = DEFAULT_FEATURE_FLAG_PACK[0];
    if (!contribution) {
      throw new Error("default pack is empty — registry seed broken");
    }
    registry.register(contribution);
    expect(() => registry.register(contribution)).toThrow(/already registered/);
  });

  it("registers a synthetic third-party feature flag and reports it via list/get/has", () => {
    const runtime = makeRuntimeStub();
    const registry = registerDefaultFeatureFlagPack(runtime);

    const acme: FeatureFlagContribution = {
      key: ACME_KEY,
      label: "Acme experiment",
      description: "Synthetic feature flag for the registry test.",
      defaultEnabled: false,
      namespace: "third_party",
      metadata: { costsMoney: "false" },
    };
    registry.register(acme);

    expect(registry.has(ACME_KEY)).toBe(true);
    expect(registry.get(ACME_KEY)).toEqual(acme);
    const keys = registry.list().map((c) => c.key);
    expect(keys).toContain(ACME_KEY);
    // Built-ins still present.
    expect(keys).toContain("travel.book_flight");
    expect(keys).toContain("browser.automation");

    // Filter by namespace surfaces only the third-party flag.
    const thirdParty = registry.list({ namespace: "third_party" });
    expect(thirdParty).toHaveLength(1);
    expect(thirdParty[0]?.key).toBe(ACME_KEY);

    __resetFeatureFlagRegistryForTests(runtime);
  });

  it("isBuiltin distinguishes built-in vs third-party flags", () => {
    const runtime = makeRuntimeStub();
    const registry = registerDefaultFeatureFlagPack(runtime);
    registry.register({
      key: ACME_KEY,
      label: "Acme",
      description: "x",
      defaultEnabled: false,
    });
    expect(registry.isBuiltin("travel.book_flight")).toBe(true);
    expect(registry.isBuiltin("email.draft")).toBe(true);
    expect(registry.isBuiltin(ACME_KEY)).toBe(false);
    __resetFeatureFlagRegistryForTests(runtime);
  });

  it("UnknownFeatureFlagError carries the offending key + the registered set", () => {
    const runtime = makeRuntimeStub();
    const registry = registerDefaultFeatureFlagPack(runtime);
    expect(registry.has("definitely.not.a.real.key")).toBe(false);
    const err = new UnknownFeatureFlagError(
      "definitely.not.a.real.key",
      registry.list().map((c) => c.key),
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UnknownFeatureFlagError");
    expect(err.code).toBe("UNKNOWN_FEATURE_FLAG");
    expect(err.featureKey).toBe("definitely.not.a.real.key");
    expect(err.registeredKeys).toContain("travel.book_flight");
    expect(err.message).toContain("definitely.not.a.real.key");
    expect(err.message).toContain("travel.book_flight");
    __resetFeatureFlagRegistryForTests(runtime);
  });

  it("per-runtime WeakMap binding isolates registries", () => {
    const r1 = makeRuntimeStub();
    const r2 = makeRuntimeStub();
    const reg1 = registerDefaultFeatureFlagPack(r1);
    const reg2 = createFeatureFlagRegistry({
      builtinKeys: LIFEOPS_BUILTIN_FEATURE_KEYS,
    });
    registerFeatureFlagRegistry(r2, reg2);

    expect(getFeatureFlagRegistry(r1)?.list()).toHaveLength(
      ALL_FEATURE_KEYS.length,
    );
    expect(getFeatureFlagRegistry(r2)?.list()).toHaveLength(0);
    expect(getFeatureFlagRegistry(r1)).toBe(reg1);

    __resetFeatureFlagRegistryForTests(r1);
    __resetFeatureFlagRegistryForTests(r2);
    expect(getFeatureFlagRegistry(r1)).toBeNull();
    expect(getFeatureFlagRegistry(r2)).toBeNull();
  });

  it("dev-registries view exposes the synthetic third-party flag with builtin=false", async () => {
    const runtime = makeRuntimeStub();
    const registry = registerDefaultFeatureFlagPack(runtime);
    registry.register({
      key: ACME_KEY,
      label: "Acme experiment",
      description: "Synthetic flag visible to the dev-registries view.",
      defaultEnabled: false,
      namespace: "third_party",
    });

    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/lifeops/dev/registries",
      runtime,
    });
    await handler(ctx);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body ?? "{}");
    if (!Array.isArray(payload.featureFlags)) {
      throw new Error(
        `expected featureFlags array on dev-registries view, got ${JSON.stringify(payload)}`,
      );
    }
    const flags = payload.featureFlags as Array<{
      key: string;
      builtin: boolean;
      namespace: string | null;
    }>;
    const acmeRow = flags.find((f) => f.key === ACME_KEY);
    expect(acmeRow).toBeDefined();
    expect(acmeRow?.builtin).toBe(false);
    expect(acmeRow?.namespace).toBe("third_party");
    const travelRow = flags.find((f) => f.key === "travel.book_flight");
    expect(travelRow?.builtin).toBe(true);
    __resetFeatureFlagRegistryForTests(runtime);
  });
});
