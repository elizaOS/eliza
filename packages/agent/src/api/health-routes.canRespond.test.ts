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
  return {
    getModel: (key: string) =>
      opts.hasTextHandler && key === ModelType.TEXT_LARGE
        ? () => undefined
        : undefined,
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
});
