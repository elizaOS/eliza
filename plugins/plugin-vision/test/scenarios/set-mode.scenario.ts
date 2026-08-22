/**
 * Keyless per-plugin e2e for `@elizaos/plugin-vision`.
 *
 * Exercises the VISION action end-to-end with NO camera, screen-capture, OCR
 * engine, or model credentials. A "turn vision mode off" request routes through
 * the VISION action's `set_mode` operation, which talks only to the in-process
 * VisionService (no external device/tool) and reports the mode change. The
 * service remains on its production startup path; the direct action supplies
 * its structural discriminator without a synthetic provider.
 */
import {
  describeCalls,
  successfulActionData,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

const VISION = "VISION";

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "model-free",
    reason: "direct production action path has no model boundary",
  },
  id: "vision.set-mode",
  title: "Vision: switch vision mode via the VISION action (keyless)",
  domain: "vision",
  tags: ["smoke", "vision", "perception"],
  description:
    "Switches the agent's vision mode through the VISION action's set_mode op — no camera, screen capture, OCR engine, or model credentials.",

  requires: { plugins: ["@elizaos/plugin-vision"] },
  isolation: "per-scenario",

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
