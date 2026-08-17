/** Exercises health route can-respond HTTP behavior with deterministic server test doubles. */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { computeCanRespond } from "./health-routes";

/**
 * computeCanRespond is the single source of truth for "first-turn capability
 * online" shared by GET /api/status AND the WS `status` broadcast. Locking the
 * contract here keeps the two readiness signals from drifting (the drift that
 * stuck the chat composer on "waking up").
 */
function makeRuntime(opts: { hasTextHandler: boolean }): AgentRuntime {
  const registrations = opts.hasTextHandler
    ? [
        {
          modelType: ModelType.TEXT_LARGE,
          provider: "test-provider",
          priority: 0,
          registrationOrder: 1,
        },
      ]
    : [];
  return {
    getModel: (key: string) =>
      opts.hasTextHandler && key === ModelType.TEXT_LARGE
        ? () => undefined
        : undefined,
    getModelRegistrations: () => registrations,
  } as unknown as AgentRuntime;
}

describe("computeCanRespond", () => {
  it("is false when there is no runtime", () => {
    expect(computeCanRespond(null, "running")).toBe(false);
  });

  it("is false when the agent is not running, even with a text handler", () => {
    expect(
      computeCanRespond(makeRuntime({ hasTextHandler: true }), "starting"),
    ).toBe(false);
  });

  it("is false when running but no TEXT generation handler is registered", () => {
    expect(
      computeCanRespond(makeRuntime({ hasTextHandler: false }), "running"),
    ).toBe(false);
  });

  it("is true once running with a registered TEXT generation handler", () => {
    expect(
      computeCanRespond(makeRuntime({ hasTextHandler: true }), "running"),
    ).toBe(true);
  });

  it("is false when the only text registration is a routing proxy", () => {
    const runtime = {
      getModel: () => () => undefined,
      getModelRegistrations: () => [
        {
          modelType: ModelType.TEXT_SMALL,
          provider: "test-router",
          priority: Number.MAX_SAFE_INTEGER,
          registrationOrder: 1,
          metadata: { routingProxy: true },
        },
      ],
    } as unknown as AgentRuntime;

    expect(computeCanRespond(runtime, "running")).toBe(false);
  });

  it("is true when a routing proxy has a concrete text candidate", () => {
    const runtime = {
      getModel: () => () => undefined,
      getModelRegistrations: () => [
        {
          modelType: ModelType.TEXT_SMALL,
          provider: "test-router",
          priority: Number.MAX_SAFE_INTEGER,
          registrationOrder: 1,
          metadata: { routingProxy: true },
        },
        {
          modelType: ModelType.TEXT_SMALL,
          provider: "test-provider",
          priority: 0,
          registrationOrder: 2,
        },
      ],
    } as unknown as AgentRuntime;

    expect(computeCanRespond(runtime, "running")).toBe(true);
  });
});
