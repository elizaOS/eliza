/** Exercises health route can-respond WebSocket behavior with deterministic server test doubles. */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { computeCanRespond } from "./health-routes.ts";

/**
 * WS `status` wire-contract guard for `canRespond` (fix for #8777: the WS status
 * broadcast omitted `canRespond`, so every 5s broadcast — and every (re)connect
 * — reset the client's `agentStatus.canRespond` to `undefined` and re-gated the
 * chat composer back to "waking up").
 *
 * Booting the full `startApiServer` to assert the live WS payload is not viable
 * in this vitest lane: `server.ts` imports `@elizaos/app-core/api/cloud-pair-route`
 * (and other subpaths) which the package's `@elizaos/app-core` test alias rewrites
 * to a non-directory path (ENOTDIR), so the module graph fails to load. No
 * committed agent test imports `server.ts` for that reason.
 *
 * Instead this pins the derivation that BOTH WS payload sites in `server.ts`
 * (the initial-connect status at the `wss.on("connection")` handler, and the
 * 5s `broadcastStatus`) compute via the SAME `computeCanRespond(state.runtime,
 * state.agentState)` call that `/api/status` and `/api/health` use. Exhaustively
 * locking every `(runtime, agentState)` combination the broadcast depends on
 * catches a regression in the readiness signal those payloads carry. The
 * presence-on-the-wire half (that the field is serialized at all) is covered by
 * the `canRespond:` literals threaded through the three call sites in
 * `health-routes.ts` / `server.ts` and asserted structurally below: the function
 * always returns a strict `boolean`, never `undefined`.
 */

/** Every agent lifecycle state the WS `status` payload can carry. */
const ALL_AGENT_STATES = [
  "not_started",
  "starting",
  "running",
  "stopped",
  "error",
  "restarting",
] as const;

/**
 * Build a runtime whose registration inventory and legacy getModel lookup both
 * expose exactly the supplied model keys.
 */
function makeRuntime(modelKeys: string[]): AgentRuntime {
  const wired = new Set(modelKeys);
  return {
    getModel: (key: string) => (wired.has(key) ? () => undefined : undefined),
    getModelRegistrations: () =>
      modelKeys.map((modelType, index) => ({
        modelType,
        provider: "test-provider",
        priority: 0,
        registrationOrder: index + 1,
      })),
  } as unknown as AgentRuntime;
}

describe("computeCanRespond — WS status broadcast contract", () => {
  it("always returns a strict boolean, never undefined (the #8777 omission)", () => {
    // The bug shipped `canRespond: undefined` onto the wire. Pin that this
    // signal is ALWAYS a concrete boolean for every input the payload feeds it,
    // so a serialized `status` event can never drop the field to `undefined`.
    for (const agentState of ALL_AGENT_STATES) {
      expect(typeof computeCanRespond(null, agentState)).toBe("boolean");
      expect(
        typeof computeCanRespond(
          makeRuntime([ModelType.TEXT_LARGE]),
          agentState,
        ),
      ).toBe("boolean");
    }
  });

  it("is false for every non-running state even with a text handler wired", () => {
    // The WS payload is sent on connect and re-sent every 5s across the whole
    // lifecycle. Only `running` may answer a first turn; everything else gates.
    const runtime = makeRuntime([ModelType.TEXT_LARGE]);
    for (const agentState of ALL_AGENT_STATES) {
      if (agentState === "running") continue;
      expect(computeCanRespond(runtime, agentState)).toBe(false);
    }
  });

  it("is false when running but no runtime is attached yet", () => {
    // Initial-connect status can fire before the runtime is wired onto state.
    expect(computeCanRespond(null, "running")).toBe(false);
  });

  it("is false when running with a runtime that has no generation handler", () => {
    // No model provider wired (local-inference is optional): running, but the
    // composer must stay gated.
    expect(computeCanRespond(makeRuntime([]), "running")).toBe(false);
  });

  it("is true once running with a registered TEXT_LARGE handler", () => {
    expect(
      computeCanRespond(makeRuntime([ModelType.TEXT_LARGE]), "running"),
    ).toBe(true);
  });

  it("is true running with any direct chat text provider registration", () => {
    const handlerKeys = [
      ModelType.TEXT_LARGE,
      ModelType.TEXT_SMALL,
      ModelType.TEXT_MEDIUM,
      ModelType.TEXT_NANO,
      ModelType.TEXT_MEGA,
    ];
    for (const key of handlerKeys) {
      expect(computeCanRespond(makeRuntime([key]), "running")).toBe(true);
    }
  });

  it("is false when only planner/response wrappers exist without a chat text provider", () => {
    expect(
      computeCanRespond(
        makeRuntime([ModelType.ACTION_PLANNER, ModelType.RESPONSE_HANDLER]),
        "running",
      ),
    ).toBe(false);
  });

  it("is false running when only a non-text handler (e.g. embedding) is wired", () => {
    // An embedding-only runtime can run but cannot generate a reply, so the
    // composer must stay gated.
    expect(
      computeCanRespond(makeRuntime([ModelType.TEXT_EMBEDDING]), "running"),
    ).toBe(false);
  });

  it("is false (not thrown) when getModel throws during the probe", () => {
    // The broadcast must never crash the WS send loop; a throwing runtime
    // degrades to a gated composer rather than propagating.
    const throwingRuntime = {
      getModel: () => {
        throw new Error("runtime probe exploded");
      },
    } as unknown as AgentRuntime;
    expect(computeCanRespond(throwingRuntime, "running")).toBe(false);
  });
});
