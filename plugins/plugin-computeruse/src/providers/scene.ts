/**
 * `scene` provider — surfaces the latest Scene from the computeruse service's
 * SceneBuilder into the agent prompt and provider data.
 *
 * Contract:
 *   - On every turn, we run `onAgentTurn()` to refresh the scene before
 *     reading it. WS7 (Brain) re-reads via `service.getCurrentScene()` for
 *     deeper introspection.
 *   - The provider text is a token-efficient JSON fence built by
 *     `serializeSceneForPrompt`. We never emit raw pixels.
 *   - The provider data is the FULL Scene so downstream pieces can crop /
 *     correlate / filter without re-serializing.
 *
 * Cache:
 *   - `cacheStable: false` — the Scene is by definition turn-specific.
 *   - `cacheScope: "turn"` — re-use within a single turn so multiple
 *     consumers don't double-tick the builder.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { serializeSceneForPrompt } from "../scene/serialize.js";
import type { ComputerUseService } from "../services/computer-use-service.js";

export const sceneProvider: Provider = {
  name: "scene",
  description:
    "Live desktop scene: displays, focused window, apps, OCR text boxes, accessibility elements, and (when set) VLM annotations. Coordinates are local to displayId.",
  descriptionCompressed:
    "display, focused window, apps, OCR boxes, AX nodes, VLM annotations; coords local",
  contexts: ["browser", "automation", "admin"],
  contextGate: { anyOf: ["browser", "automation", "admin"] },
  cacheStable: false,
  cacheScope: "turn",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService("computeruse") as
      | ComputerUseService
      | undefined;
    if (!service) {
      return { text: "" };
    }
    let scene = service.getCurrentScene();
    if (!scene) {
      try {
        scene = await service.refreshScene("agent-turn");
      } catch (error) {
        // error-policy:J4 the empty provider result is the designed degrade,
        // and the failure is reported so the agent sees a broken scene
        // pipeline via RECENT_ERRORS instead of a silently sceneless turn.
        runtime.reportError("Computeruse.sceneProvider", error);
        return { text: "" };
      }
    }
    if (!scene) return { text: "" };
    const text = serializeSceneForPrompt(scene);
    return {
      text,
      values: {
        sceneTimestamp: scene.timestamp,
        sceneDisplayCount: scene.displays.length,
        sceneOcrCount: scene.ocr.length,
        sceneAxCount: scene.ax.length,
      },
      data: { scene },
    };
  },
};
