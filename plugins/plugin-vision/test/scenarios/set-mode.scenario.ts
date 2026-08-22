/**
 * Keyless per-plugin e2e for `@elizaos/plugin-vision`.
 *
 * Exercises the VISION action end-to-end with NO camera, screen-capture, OCR
 * engine, or model credentials. A "turn vision mode off" request routes through
 * the VISION action's `set_mode` operation, which talks only to the in-process
 * VisionService (no external device/tool) and reports the mode change. The
 * service is booted in OFF mode so startup performs no camera/screen probing.
 */
import type { AgentRuntime, Provider } from "@elizaos/core";
import {
  describeCalls,
  successfulActionData,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

const VISION = "VISION";
type R = AgentRuntime & {
  setSetting?: (k: string, v: string) => void;
  registerProvider?: (provider: Provider) => void;
};

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [],
  },
  id: "vision.set-mode",
  title: "Vision: switch vision mode via the VISION action (keyless)",
  domain: "vision",
  tags: ["smoke", "vision", "perception"],
  description:
    "Switches the agent's vision mode through the VISION action's set_mode op — no camera, screen capture, OCR engine, or model credentials.",

  requires: { plugins: ["@elizaos/plugin-vision"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "vision-config-and-fixtures",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        // Boot the VisionService in OFF mode so startup probes no camera/screen
        // tool — set_mode is the one op that runs without an active capture.
        process.env.VISION_MODE = "off";
        runtime.setSetting?.("VISION_MODE", "off");

        // The VISION action's validate gates exposure on a vision context being
        // selected for the turn (state.values.selectedContexts), but the v5
        // planner surfaces the routed contexts under a different state key, so
        // a vision action would never be offered to the planner in the keyless
        // harness. Surface the routed "media" vision context to validate via an
        // always-on response-state provider — the real action then runs for
        // real (set_mode actually flips the live VisionService mode).
        runtime.registerProvider?.({
          name: "VISION_SCENARIO_CONTEXT",
          alwaysInResponseState: true,
          get: async () => ({
            text: "",
            values: { selectedContexts: ["media"] },
            data: {},
          }),
        });

        return undefined;
      },
    },
  ],

  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Vision" },
  ],

  turns: [
    {
      kind: "action",
      name: "set-mode",
      actionName: VISION,
      options: { parameters: { action: "set_mode", mode: "off" } },
      text: "Turn vision mode off.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find((a) => a.actionName === VISION);
        if (!call) {
          return `Expected ${VISION} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${VISION} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: VISION,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the set_mode op really flipped the live
      // VisionService — the service's own getVisionMode() must report "off"
      // after the turn, and the result payload must carry the applied mode.
      type: "custom",
      name: "vision-mode-applied-effect",
      predicate: (ctx) => {
        const data = successfulActionData(ctx, VISION);
        if (!data) {
          return `no successful ${VISION} result data; calls: ${describeCalls(ctx)}`;
        }
        if (
          data.op !== "set_mode" ||
          String(data.visionMode).toLowerCase() !== "off"
        ) {
          return `expected result.data op "set_mode" with visionMode OFF, saw ${JSON.stringify(data).slice(0, 200)}`;
        }
        const runtime = ctx.runtime as {
          getService?: (
            type: string,
          ) => { getVisionMode?: () => string } | null;
        };
        const service = runtime.getService?.("VISION");
        if (!service || typeof service.getVisionMode !== "function") {
          return "VisionService is not registered — cannot verify the live mode";
        }
        const liveMode = service.getVisionMode();
        if (String(liveMode).toLowerCase() !== "off") {
          return `live VisionService.getVisionMode() must be OFF after the turn, saw ${JSON.stringify(liveMode)}`;
        }
      },
    },
  ],
});
