/**
 * W1-A REST surface unit tests for the ScheduledTask routes.
 *
 * Exercises the handler with a mock LifeOpsRouteContext + an in-memory
 * runner so the route logic is testable without spinning up the full
 * runtime. The DB-backed runner is covered separately via the runtime
 * wiring path (`runtime-wiring.ts`).
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { ChannelContribution } from "../lifeops/channels/contract.js";
import {
  createChannelRegistry,
  registerChannelRegistry,
} from "../lifeops/channels/registry.js";
import type { ConnectorContribution } from "../lifeops/connectors/contract.js";
import {
  createConnectorRegistry,
  registerConnectorRegistry,
} from "../lifeops/connectors/registry.js";
import {
  createBlockerRegistry,
  createEventKindRegistry,
  createFamilyRegistry,
  createFeatureFlagRegistry,
  registerBlockerRegistry,
  registerEventKindRegistry,
  registerFamilyRegistry,
  registerFeatureFlagRegistry,
} from "../lifeops/registries/index.js";
import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "../lifeops/scheduled-task/completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "../lifeops/scheduled-task/consolidation-policy.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "../lifeops/scheduled-task/escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "../lifeops/scheduled-task/gate-registry.js";
import {
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
  TestNoopScheduledTaskDispatcher,
} from "../lifeops/scheduled-task/index.js";
import type { SendPolicyContribution } from "../lifeops/send-policy/contract.js";
import {
  createSendPolicyRegistry,
  registerSendPolicyRegistry,
} from "../lifeops/send-policy/registry.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";
import { makeScheduledTasksRouteHandler } from "./scheduled-tasks.js";

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
    dispatcher: TestNoopScheduledTaskDispatcher,
  });
}

interface MockResponse {
  statusCode?: number;
  body?: string;
  headers: Record<string, string>;
  ended: boolean;
}

function buildCtx(args: {
  method: string;
  pathname: string;
  body?: unknown;
  runner: ScheduledTaskRunnerHandle;
}): { ctx: LifeOpsRouteContext; res: MockResponse } {
  const res: MockResponse = { headers: {}, ended: false };
  const socket = new Socket();
  setRemoteAddress(socket, "127.0.0.1");
  const httpReq = new IncomingMessage(socket);
  httpReq.method = args.method;
  httpReq.headers = args.body
    ? { "content-type": "application/json", "content-length": "1" }
    : {};

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
    state: { runtime: null, adminEntityId: null },
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
      return (args.body as T | undefined) ?? null;
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

function setRemoteAddress(socket: Socket, remoteAddress: string): void {
  Object.defineProperty(socket, "remoteAddress", {
    value: remoteAddress,
    configurable: true,
  });
}

describe("scheduled-tasks REST handler", () => {
  it("POST /api/lifeops/scheduled-tasks creates and returns a task", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "drink water",
        trigger: { kind: "manual" },
        priority: "low",
        respectsGlobalPause: true,
        source: "user_chat",
        createdBy: "tester",
        ownerVisible: true,
      },
      runner,
    });
    const handled = await handler(ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(201);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.task.taskId).toBeDefined();
    expect(payload.task.state.status).toBe("scheduled");
  });

  it("POST schedule rejects invalid payloads with 400", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/scheduled-tasks",
      body: { kind: "not-a-real-kind" },
      runner,
    });
    await handler(ctx);
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/lifeops/scheduled-tasks lists tasks", async () => {
    const runner = makeRunner();
    await runner.schedule({
      kind: "reminder",
      promptInstructions: "ping",
      trigger: { kind: "manual" },
      priority: "low",
      respectsGlobalPause: true,
      source: "user_chat",
      createdBy: "x",
      ownerVisible: true,
    });
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/lifeops/scheduled-tasks",
      runner,
    });
    await handler(ctx);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.tasks).toHaveLength(1);
  });

  it("POST /:id/complete fires onComplete pipeline; /:id/acknowledge does not (cross-agent §7.6)", async () => {
    const runner = makeRunner();
    const child = {
      kind: "reminder" as const,
      promptInstructions: "child-of-pipeline",
      trigger: { kind: "manual" as const },
      priority: "low" as const,
      respectsGlobalPause: true,
      source: "user_chat" as const,
      createdBy: "x",
      ownerVisible: true,
    };
    const parent = await runner.schedule({
      ...child,
      promptInstructions: "parent",
      pipeline: { onComplete: [child as never] },
    });
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    {
      const { ctx, res } = buildCtx({
        method: "POST",
        pathname: `/api/lifeops/scheduled-tasks/${parent.taskId}/complete`,
        body: { reason: "smoke" },
        runner,
      });
      await handler(ctx);
      expect(res.statusCode).toBe(200);
    }
    const all = await runner.list();
    expect(
      all.find((t) => t.promptInstructions === "child-of-pipeline"),
    ).toBeDefined();
  });

  it("GET /:id/history returns user-visible state surface", async () => {
    const runner = makeRunner();
    const task = await runner.schedule({
      kind: "reminder",
      promptInstructions: "x",
      trigger: { kind: "manual" },
      priority: "low",
      respectsGlobalPause: true,
      source: "user_chat",
      createdBy: "x",
      ownerVisible: true,
    });
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: `/api/lifeops/scheduled-tasks/${task.taskId}/history`,
      runner,
    });
    await handler(ctx);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.taskId).toBe(task.taskId);
    expect(payload.status).toBe("scheduled");
  });

  it("GET /api/lifeops/dev/registries returns registry health (loopback only)", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/lifeops/dev/registries",
      runner,
    });
    await handler(ctx);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body ?? "{}");
    expect(payload.gates).toEqual(
      expect.arrayContaining([
        "weekend_skip",
        "weekday_only",
        "weekend_only",
        "late_evening_skip",
        "quiet_hours",
        "during_travel",
      ]),
    );
  });

  it("GET /api/lifeops/dev/registries surfaces every registry kind for runtime composability proof", async () => {
    const runner = makeRunner();
    const fakeRuntime = {} as AgentRuntime;

    // Connector registry — minimal acme contribution.
    const connectorRegistry = createConnectorRegistry();
    const acmeConnector: ConnectorContribution = {
      kind: "acme_inbox",
      capabilities: ["acme.inbox.read", "acme.inbox.send"],
      modes: ["cloud"],
      describe: { label: "Acme Inbox" },
      start: async () => {},
      disconnect: async () => {},
      verify: async () => true,
      status: async () => ({
        state: "ok",
        observedAt: new Date().toISOString(),
      }),
      requiresApproval: true,
    };
    connectorRegistry.register(acmeConnector);
    registerConnectorRegistry(fakeRuntime, connectorRegistry);

    // Channel registry — a synthetic acme channel.
    const channelRegistry = createChannelRegistry();
    const acmeChannel: ChannelContribution = {
      kind: "acme_channel",
      describe: { label: "Acme Channel" },
      capabilities: {
        send: true,
        read: false,
        reminders: true,
        voice: false,
        attachments: false,
        quietHoursAware: true,
      },
    };
    channelRegistry.register(acmeChannel);
    registerChannelRegistry(fakeRuntime, channelRegistry);

    // Send-policy registry — synthetic policy.
    const sendPolicyRegistry = createSendPolicyRegistry();
    const acmePolicy: SendPolicyContribution = {
      kind: "acme_owner_consent_required",
      describe: { label: "Acme owner-consent gate" },
      priority: 50,
      evaluate: () => ({ kind: "allow" }),
    };
    sendPolicyRegistry.register(acmePolicy);
    registerSendPolicyRegistry(fakeRuntime, sendPolicyRegistry);

    // Event-kind registry.
    const eventKindRegistry = createEventKindRegistry();
    eventKindRegistry.register({
      eventKind: "acme.inbox.message",
      describe: { label: "Acme inbox new message", provider: "acme" },
    });
    registerEventKindRegistry(fakeRuntime, eventKindRegistry);

    // Family registry.
    const familyRegistry = createFamilyRegistry();
    familyRegistry.register({
      family: "acme.inbox.message",
      description: "Acme bus family",
      source: "acme",
      namespace: "acme",
    });
    registerFamilyRegistry(fakeRuntime, familyRegistry);

    // Blocker registry — built-ins seeded via the registry directly so we
    // exercise the public registration path without booting the full plugin.
    const blockerRegistry = createBlockerRegistry();
    blockerRegistry.register({
      kind: "website",
      describe: { label: "Website blocker" },
      verifyAvailable: async () => ({
        available: true,
        reason: null,
        permission: "granted",
      }),
      start: async () => undefined,
      stop: async () => {},
      status: async () => ({
        active: false,
        endsAt: null,
        text: "idle",
      }),
    });
    registerBlockerRegistry(fakeRuntime, blockerRegistry);

    // Feature-flag registry — synthetic 3rd-party flag.
    const featureFlagRegistry = createFeatureFlagRegistry({
      builtinKeys: new Set(),
    });
    featureFlagRegistry.register({
      key: "acme.experiment",
      label: "Acme experiment",
      description: "Synthetic feature flag for the composability proof.",
      defaultEnabled: false,
      namespace: "third_party",
    });
    registerFeatureFlagRegistry(fakeRuntime, featureFlagRegistry);

    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/lifeops/dev/registries",
      runner,
    });
    ctx.state.runtime = fakeRuntime;

    await handler(ctx);
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body ?? "{}");

    // Runner-internal registries (existing behaviour).
    expect(payload.gates).toEqual(expect.arrayContaining(["weekend_skip"]));
    expect(payload.completionChecks).toBeDefined();
    expect(payload.ladders).toBeDefined();
    expect(payload.anchors).toBeDefined();
    expect(payload.consolidationPolicies).toBeDefined();

    // Connectors.
    const connectorKinds = (payload.connectors as Array<{ kind: string }>).map(
      (c) => c.kind,
    );
    expect(connectorKinds).toContain("acme_inbox");
    const acme = (
      payload.connectors as Array<{
        kind: string;
        requiresApproval: boolean;
        capabilities: string[];
      }>
    ).find((c) => c.kind === "acme_inbox");
    expect(acme?.requiresApproval).toBe(true);
    expect(acme?.capabilities).toContain("acme.inbox.read");

    // Channels.
    expect(
      (payload.channels as Array<{ kind: string }>).map((c) => c.kind),
    ).toContain("acme_channel");

    // Send policies.
    expect(
      (payload.sendPolicies as Array<{ kind: string }>).map((p) => p.kind),
    ).toContain("acme_owner_consent_required");

    // Event kinds.
    expect(
      (payload.eventKinds as Array<{ eventKind: string }>).map(
        (e) => e.eventKind,
      ),
    ).toContain("acme.inbox.message");

    // Bus families.
    expect(
      (payload.busFamilies as Array<{ family: string }>).map((f) => f.family),
    ).toContain("acme.inbox.message");

    // Blockers.
    expect(
      (payload.blockers as Array<{ kind: string }>).map((b) => b.kind),
    ).toContain("website");

    // Feature flags.
    expect(
      (payload.featureFlags as Array<{ key: string }>).map((f) => f.key),
    ).toContain("acme.experiment");
  });

  it("rejects /api/lifeops/dev/registries when not on loopback", async () => {
    const runner = makeRunner();
    const handler = makeScheduledTasksRouteHandler({
      resolveRunner: async () => runner,
    });
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/lifeops/dev/registries",
      runner,
    });
    // Override remoteAddress to a public IP.
    setRemoteAddress(ctx.req.socket, "8.8.8.8");
    await handler(ctx);
    expect(res.statusCode).toBe(403);
  });
});
