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
import { describe, expectTypeOf, it } from "vitest";
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

describe("capacitor-bridge shim parity (#15850)", () => {
  it("keeps real bridge exports assignable to their shim contracts", () => {
    expectTypeOf<RealAgentRoot["startEliza"]>().toMatchTypeOf<
      ShimAgentRoot["startEliza"]
    >();
    expectTypeOf<RealAgentRoot["dispatchRoute"]>().toMatchTypeOf<
      ShimAgentRoot["dispatchRoute"]
    >();
    expectTypeOf<RealAgentRoot["configFileExists"]>().toMatchTypeOf<
      ShimAgentRoot["configFileExists"]
    >();
    expectTypeOf<RealAgentRoot["loadElizaConfig"]>().toMatchTypeOf<
      ShimAgentRoot["loadElizaConfig"]
    >();
    expectTypeOf<RealAgentRoot["saveElizaConfig"]>().toMatchTypeOf<
      ShimAgentRoot["saveElizaConfig"]
    >();
    expectTypeOf<RealAgentRoot["hasPersistedFirstRunState"]>().toMatchTypeOf<
      ShimAgentRoot["hasPersistedFirstRunState"]
    >();
    expectTypeOf<
      RealAgentApi["dispatchRoute"]
    >().toMatchTypeOf<AndroidDispatchRoute>();
    expectTypeOf<
      Pick<
        RealAgentRoot,
        | "configFileExists"
        | "loadElizaConfig"
        | "saveElizaConfig"
        | "hasPersistedFirstRunState"
      >
    >().toMatchTypeOf<AndroidCoreRouteDeps>();
    expectTypeOf<RealAgentApi["dispatchRoute"]>().toMatchTypeOf<
      ShimAgentApi["dispatchRoute"]
    >();
    expectTypeOf<RealAgentRuntime["bootElizaRuntime"]>().toMatchTypeOf<
      ShimAgentRuntime["bootElizaRuntime"]
    >();
    expectTypeOf<
      RealLocalInferenceRuntime["installRouterHandler"]
    >().toMatchTypeOf<
      (runtime: AgentRuntime, options: Record<string, never>) => void
    >();
  });
});
