/**
 * Unit coverage for getAgentEventService: duck-typed lookup across the
 * published service-type aliases. Drives the real resolver with an in-memory
 * runtime map and a subscribe-capable service — no production-module mocks.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_EVENT_SERVICE_TYPES,
  type AgentEventPayloadLike,
  type AgentEventServiceLike,
  getAgentEventService,
} from "./agent-event-service.ts";

type RuntimeLike = {
  getService: (serviceType: string) => unknown | null;
};

function makeEventService(): AgentEventServiceLike & {
  eventListeners: Array<(event: AgentEventPayloadLike) => void>;
} {
  const eventListeners: Array<(event: AgentEventPayloadLike) => void> = [];
  return {
    eventListeners,
    subscribe(listener) {
      eventListeners.push(listener);
      return () => {
        const index = eventListeners.indexOf(listener);
        if (index === -1) {
          return;
        }
        eventListeners.splice(index, 1);
      };
    },
    subscribeHeartbeat() {
      return () => {};
    },
    getLastHeartbeat() {
      return null;
    },
  };
}

function makeRuntime(
  services: Record<string, unknown | null> = {},
): RuntimeLike & { probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    getService(serviceType: string) {
      probed.push(serviceType);
      if (!Object.hasOwn(services, serviceType)) {
        return null;
      }
      return services[serviceType];
    },
  };
}

describe("AGENT_EVENT_SERVICE_TYPES", () => {
  it("probes the lowercase alias before the uppercase alias", () => {
    expect(AGENT_EVENT_SERVICE_TYPES).toEqual(["agent_event", "AGENT_EVENT"]);
  });
});

describe("getAgentEventService", () => {
  it("returns null when the runtime is missing", () => {
    expect(getAgentEventService(null)).toBeNull();
    expect(getAgentEventService(undefined)).toBeNull();
  });

  it("returns null when the registry is empty", () => {
    const runtime = makeRuntime();
    expect(getAgentEventService(runtime)).toBeNull();
    expect(runtime.probed).toEqual(["agent_event", "AGENT_EVENT"]);
  });

  it("returns the lowercase-alias service without probing the uppercase alias", () => {
    const service = makeEventService();
    const runtime = makeRuntime({ agent_event: service });
    expect(getAgentEventService(runtime)).toBe(service);
    expect(runtime.probed).toEqual(["agent_event"]);
  });

  it("falls through to AGENT_EVENT when agent_event is unregistered", () => {
    const service = makeEventService();
    const runtime = makeRuntime({ AGENT_EVENT: service });
    expect(getAgentEventService(runtime)).toBe(service);
    expect(runtime.probed).toEqual(["agent_event", "AGENT_EVENT"]);
  });

  it("treats a falsy getService result as unregistered and keeps probing", () => {
    const fallback = makeEventService();
    const runtime = makeRuntime({
      agent_event: null,
      AGENT_EVENT: fallback,
    });
    expect(getAgentEventService(runtime)).toBe(fallback);
    expect(runtime.probed).toEqual(["agent_event", "AGENT_EVENT"]);
  });

  it("skips a registered object that is missing subscribe", () => {
    const fallback = makeEventService();
    const runtime = makeRuntime({
      agent_event: { subscribeHeartbeat: () => () => {} },
      AGENT_EVENT: fallback,
    });
    expect(getAgentEventService(runtime)).toBe(fallback);
  });

  it("skips a subscribe property that is not a function", () => {
    const fallback = makeEventService();
    const runtime = makeRuntime({
      agent_event: { subscribe: "listen" },
      AGENT_EVENT: fallback,
    });
    expect(getAgentEventService(runtime)).toBe(fallback);
  });

  it("prefers the first alias when both aliases expose a valid service", () => {
    const first = makeEventService();
    const second = makeEventService();
    const runtime = makeRuntime({
      agent_event: first,
      AGENT_EVENT: second,
    });
    expect(getAgentEventService(runtime)).toBe(first);
    expect(runtime.probed).toEqual(["agent_event"]);
  });

  it("accepts a service that only implements subscribe", () => {
    const service = { subscribe: () => () => {} };
    const runtime = makeRuntime({ agent_event: service });
    expect(getAgentEventService(runtime)).toBe(service);
  });

  it("returns the live service identity so subscribe reaches the same listeners", () => {
    const service = makeEventService();
    const runtime = makeRuntime({ agent_event: service });
    const resolved = getAgentEventService(runtime);
    expect(resolved).toBe(service);
    if (!resolved) {
      throw new Error("getAgentEventService returned null");
    }

    const received: AgentEventPayloadLike[] = [];
    const unsubscribe = resolved.subscribe((event) => {
      received.push(event);
    });
    const payload: AgentEventPayloadLike = {
      runId: "run-1",
      seq: 1,
      stream: "thought",
      ts: 1,
      data: { text: "hello" },
    };
    for (const listener of service.eventListeners) {
      listener(payload);
    }
    expect(received).toEqual([payload]);

    unsubscribe();
    expect(service.eventListeners).toEqual([]);
  });
});
