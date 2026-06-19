import { describe, expect, it } from "bun:test";
import {
  buildAnnounceDescriptor,
  createHandlerRegistry,
  type RemoteServiceInstance,
  type WorkerPluginShape,
} from "./descriptor.js";

type DescriptorForTest = Record<string, unknown> & {
  actions: Array<Record<string, unknown>>;
  providers: Array<Record<string, unknown>>;
  models: Record<string, unknown>;
  events: Record<string, unknown[]>;
  evaluators: Array<Record<string, unknown>>;
  routes: Array<Record<string, unknown>>;
  services: Array<Record<string, unknown>>;
};

function rpcId(value: unknown): string {
  expect(value).toMatchObject({ rpc: true });
  const id = (value as { id?: unknown }).id;
  expect(typeof id).toBe("string");
  return id as string;
}

describe("buildAnnounceDescriptor", () => {
  it("replaces every callable surface with registry-backed rpc refs", () => {
    const registry = createHandlerRegistry();
    const handlers = {
      actionValidate: () => true,
      actionHandler: () => ({ ok: true }),
      providerGet: () => ({ text: "context" }),
      model: () => "model-output",
      eventA: () => undefined,
      eventB: () => undefined,
      evaluatorValidate: () => true,
      evaluatorHandler: () => ({ score: 1 }),
      routeHandler: () => new Response("ok"),
    };
    const plugin = {
      name: "worker-plugin",
      description: "remote test plugin",
      mode: "direct",
      priority: 5,
      dependencies: ["dep-a"],
      config: { enabled: true },
      schema: { type: "object" },
      actions: [
        {
          name: "act",
          similes: ["do"],
          description: "action",
          examples: [{ user: "u", content: { text: "hi" } }],
          validate: handlers.actionValidate,
          handler: handlers.actionHandler,
        },
      ],
      providers: [
        {
          name: "provider",
          description: "provider description",
          dynamic: true,
          position: 10,
          private: true,
          get: handlers.providerGet,
        },
      ],
      models: { TEXT_SMALL: handlers.model },
      events: { MESSAGE_RECEIVED: [handlers.eventA, handlers.eventB] },
      evaluators: [
        {
          name: "eval",
          description: "evaluator",
          validate: handlers.evaluatorValidate,
          handler: handlers.evaluatorHandler,
        },
      ],
      routes: [
        {
          type: "POST",
          name: "route",
          path: "/route",
          public: true,
          isMultipart: false,
          routeHandler: handlers.routeHandler,
        },
      ],
      views: [{ name: "view" }],
      widgets: [{ name: "widget" }],
      componentTypes: [{ name: "component" }],
    } satisfies WorkerPluginShape;

    const descriptor = buildAnnounceDescriptor(
      plugin,
      registry,
    ) as DescriptorForTest;

    expect(descriptor).toMatchObject({
      name: "worker-plugin",
      mode: "remote",
      description: "remote test plugin",
      priority: 5,
      dependencies: ["dep-a"],
      config: { enabled: true },
      schema: { type: "object" },
      views: [{ name: "view" }],
      widgets: [{ name: "widget" }],
      componentTypes: [{ name: "component" }],
    });

    const action = descriptor.actions[0] ?? {};
    expect(action).toMatchObject({
      name: "act",
      similes: ["do"],
      description: "action",
    });
    const actionHandlerId = rpcId(action.handler);
    const actionValidateId = rpcId(action.validate);
    expect(registry.get(actionHandlerId)).toMatchObject({
      surface: "action",
      target: "act",
      handler: handlers.actionHandler,
    });
    expect(registry.get(actionValidateId)).toMatchObject({
      surface: "action",
      target: "act.validate",
      handler: handlers.actionValidate,
    });

    const providerGetId = rpcId(descriptor.providers[0]?.get);
    expect(registry.get(providerGetId)).toMatchObject({
      surface: "provider",
      target: "provider",
      handler: handlers.providerGet,
    });

    expect(registry.get(rpcId(descriptor.models.TEXT_SMALL))).toMatchObject({
      surface: "model",
      target: "TEXT_SMALL",
      handler: handlers.model,
    });
    expect(
      registry.get(rpcId(descriptor.events.MESSAGE_RECEIVED?.[0])),
    ).toMatchObject({
      surface: "event",
      target: "MESSAGE_RECEIVED#0",
      handler: handlers.eventA,
    });
    expect(
      registry.get(rpcId(descriptor.events.MESSAGE_RECEIVED?.[1])),
    ).toMatchObject({
      surface: "event",
      target: "MESSAGE_RECEIVED#1",
      handler: handlers.eventB,
    });

    expect(
      registry.get(rpcId(descriptor.evaluators[0]?.handler)),
    ).toMatchObject({
      surface: "evaluator",
      target: "eval",
      handler: handlers.evaluatorHandler,
    });
    expect(
      registry.get(rpcId(descriptor.evaluators[0]?.validate)),
    ).toMatchObject({
      surface: "evaluator",
      target: "eval.validate",
      handler: handlers.evaluatorValidate,
    });
    expect(
      registry.get(rpcId(descriptor.routes[0]?.routeHandler)),
    ).toMatchObject({
      surface: "route",
      target: "POST /route",
      handler: handlers.routeHandler,
    });
    expect(registry.size).toBe(9);
  });

  it("describes service rpc methods and starts service instances lazily once", async () => {
    const registry = createHandlerRegistry();
    const runtime = { runtime: true };
    const calls: unknown[][] = [];
    let started = 0;
    const service = {
      serviceType: "quotes",
      capabilityDescription: "Quote service",
      rpcMethods: ["quote", "count"] as const,
      async start(startRuntime: unknown): Promise<RemoteServiceInstance> {
        started += 1;
        calls.push(["start", startRuntime]);
        return {
          value: 41,
          quote(this: { value: number }, symbol: string) {
            calls.push(["quote", this.value, symbol]);
            return `${symbol}:${this.value + 1}`;
          },
          count() {
            calls.push(["count"]);
            return calls.length;
          },
        } as RemoteServiceInstance;
      },
    };

    const descriptor = buildAnnounceDescriptor(
      { name: "service-plugin", services: [service] },
      registry,
    ) as DescriptorForTest;

    expect(descriptor.services[0]).toMatchObject({
      serviceType: "quotes",
      capabilityDescription: "Quote service",
      rpcMethods: ["quote", "count"],
    });

    const quoteEntry = registry.get(
      rpcId(descriptor.services[0]?.["rpc:quote"]),
    );
    const countEntry = registry.get(
      rpcId(descriptor.services[0]?.["rpc:count"]),
    );
    expect(quoteEntry).toMatchObject({
      surface: "service",
      target: "quotes.quote",
    });
    expect(countEntry).toMatchObject({
      surface: "service",
      target: "quotes.count",
    });

    await expect(quoteEntry?.handler(runtime, "ETH")).resolves.toBe("ETH:42");
    await expect(countEntry?.handler(runtime)).resolves.toBe(3);
    expect(started).toBe(1);
    expect(calls).toEqual([
      ["start", runtime],
      ["quote", 41, "ETH"],
      ["count"],
    ]);
  });

  it("throws the intended service rpc error when an allowlisted method is missing", async () => {
    const registry = createHandlerRegistry();
    const service = {
      serviceType: "broken",
      rpcMethods: ["missing"] as const,
      async start(): Promise<RemoteServiceInstance> {
        return {};
      },
    };
    const descriptor = buildAnnounceDescriptor(
      { name: "broken-plugin", services: [service] },
      registry,
    ) as DescriptorForTest;
    const entry = registry.get(rpcId(descriptor.services[0]?.["rpc:missing"]));

    await expect(entry?.handler({})).rejects.toThrow(
      'Service broken has no rpcMethod "missing".',
    );
  });
});
