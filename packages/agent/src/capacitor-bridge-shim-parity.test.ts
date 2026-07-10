/**
 * Compile-time parity between the Capacitor bridge's type-only agent shims and
 * the real agent export surfaces (#15850). The bridge package typechecks
 * against `plugins/plugin-capacitor-bridge/src/type-shims/*` (tsconfig paths)
 * and its declaration build runs `--noCheck`, so without this file no compiler
 * verifies that the real `@elizaos/agent{,/api,/runtime}` modules still satisfy
 * what the bridge expects — drift keeps the bridge typecheck green and
 * surfaces only on-device. Every assertion here typechecks in THIS package,
 * against real sources, so drift fails `bun run --cwd packages/agent
 * typecheck` (and this suite) instead.
 *
 * Direction of the checks: at runtime the bridge holds values typed by its
 * shims and the real implementations are slotted in, so each REAL export must
 * be assignable to its SHIM (bridge-expected) type.
 */

import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type {
  AndroidCoreRouteDeps,
  AndroidDispatchRoute,
} from "../../../plugins/plugin-capacitor-bridge/src/android/dispatch.ts";

type ShimAgentRoot =
  typeof import("../../../plugins/plugin-capacitor-bridge/src/type-shims/agent-root.ts");
type ShimAgentApi =
  typeof import("../../../plugins/plugin-capacitor-bridge/src/type-shims/agent-api.ts");
type ShimAgentRuntime =
  typeof import("../../../plugins/plugin-capacitor-bridge/src/type-shims/agent-runtime.ts");

type RealAgentRoot = typeof import("./index.ts");
type RealAgentApi = typeof import("./api/index.ts");
type RealAgentRuntime = typeof import("./runtime/index.ts");
type RealLocalInferenceRuntime =
  typeof import("../../../plugins/plugin-local-inference/src/runtime/index.ts");

/**
 * Compile-time-only assignability probe: instantiating it with a `_From` that
 * does not extend `To` is a type error. The exported aliases below are the
 * actual assertions; they carry no runtime cost.
 */
type AssertAssignable<To, _From extends To> = never;

// ── @elizaos/agent (root) — Android bridge contract ─────────────────────────
// `loadAgentModule` in android/bridge.ts casts the dynamic root import to the
// same member types the agent-root shim declares.
export type StartElizaParity = AssertAssignable<
  ShimAgentRoot["startEliza"],
  RealAgentRoot["startEliza"]
>;
export type RootDispatchRouteParity = AssertAssignable<
  ShimAgentRoot["dispatchRoute"],
  RealAgentRoot["dispatchRoute"]
>;
export type ConfigFileExistsParity = AssertAssignable<
  ShimAgentRoot["configFileExists"],
  RealAgentRoot["configFileExists"]
>;
export type LoadElizaConfigParity = AssertAssignable<
  ShimAgentRoot["loadElizaConfig"],
  RealAgentRoot["loadElizaConfig"]
>;
export type SaveElizaConfigParity = AssertAssignable<
  ShimAgentRoot["saveElizaConfig"],
  RealAgentRoot["saveElizaConfig"]
>;
export type HasPersistedFirstRunStateParity = AssertAssignable<
  ShimAgentRoot["hasPersistedFirstRunState"],
  RealAgentRoot["hasPersistedFirstRunState"]
>;

// The Android dispatch/core-route types are the bridge's own vocabulary for
// the same members; pin the real exports against them directly too so a drift
// in either the shim or the bridge contract is caught.
export type AndroidDispatchParity = AssertAssignable<
  AndroidDispatchRoute,
  RealAgentApi["dispatchRoute"]
>;
export type AndroidCoreRouteDepsParity = AssertAssignable<
  AndroidCoreRouteDeps,
  Pick<
    RealAgentRoot,
    | "configFileExists"
    | "loadElizaConfig"
    | "saveElizaConfig"
    | "hasPersistedFirstRunState"
  >
>;

// ── @elizaos/agent/api — shared dispatchRoute contract ───────────────────────
export type ApiDispatchRouteParity = AssertAssignable<
  ShimAgentApi["dispatchRoute"],
  RealAgentApi["dispatchRoute"]
>;

// ── @elizaos/agent/runtime — iOS bridge contract ────────────────────────────
export type BootElizaRuntimeParity = AssertAssignable<
  ShimAgentRuntime["bootElizaRuntime"],
  RealAgentRuntime["bootElizaRuntime"]
>;

// ── @elizaos/plugin-local-inference/runtime — router install contract ───────
// The android bridge invokes `installRouterHandler(runtime, {})` with the
// booted AgentRuntime; the real export must keep accepting exactly that call.
export type InstallRouterHandlerParity = AssertAssignable<
  (runtime: AgentRuntime, options: Record<string, never>) => void,
  RealLocalInferenceRuntime["installRouterHandler"]
>;

describe("capacitor-bridge shim parity (#15850)", () => {
  it("is enforced at compile time — this file failing to typecheck IS the signal", () => {
    // The type aliases above are the assertions; tsgo/tsc rejects this file
    // (and the agent typecheck lane fails) the moment a real export drifts
    // from the bridge's shim contract.
    expect(true).toBe(true);
  });
});
