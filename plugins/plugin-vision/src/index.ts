import type { Plugin } from "@elizaos/core";
import { logger, promoteSubactionsToActions } from "@elizaos/core";
import { visionAction } from "./action";
import { wireComputerUseOcrBridge } from "./computeruse-ocr-bridge";
import {
  getOcrWithCoordsService,
  RapidOcrCoordAdapter,
  registerOcrWithCoordsService,
} from "./ocr-with-coords";
import { visionProvider } from "./provider";
import { VisionService } from "./service";

export const visionPlugin: Plugin = {
  name: "vision",
  description:
    "Provides visual perception through camera integration and scene analysis",
  services: [VisionService],
  providers: [visionProvider],
  actions: [...promoteSubactionsToActions(visionAction)],
  // Self-declared auto-enable: activate when features.vision is enabled OR
  // when media.vision.provider is configured.
  autoEnable: {
    shouldEnable: (_env, config) => {
      const f = (config?.features as Record<string, unknown> | undefined)
        ?.vision;
      const featureOn =
        f === true ||
        (typeof f === "object" &&
          f !== null &&
          (f as { enabled?: unknown }).enabled !== false);
      if (featureOn) return true;
      const media = config?.media as Record<string, unknown> | undefined;
      const visionMedia = media?.vision as
        | { enabled?: unknown; provider?: unknown }
        | undefined;
      return Boolean(
        visionMedia &&
          visionMedia.enabled !== false &&
          typeof visionMedia.provider === "string" &&
          visionMedia.provider.length > 0,
      );
    },
  },
  init: async (_config, _runtime) => {
    // Wire full-screen OCR-with-coords so plugin-computeruse's scene-builder
    // and GET_SCREEN can consume it. plugin-vision owns the OCR engines; it
    // registers a coord-OCR service locally and bridges it into computeruse's
    // CoordOcrProvider seam via a best-effort dynamic import (no hard dep — the
    // bridge is skipped cleanly when computeruse is not installed).
    if (!getOcrWithCoordsService()) {
      registerOcrWithCoordsService(new RapidOcrCoordAdapter());
    }
    try {
      const mod = (await import(
        "@elizaos/plugin-computeruse/mobile/ocr-provider"
      )) as { registerCoordOcrProvider?: (provider: unknown) => void };
      if (typeof mod.registerCoordOcrProvider === "function") {
        wireComputerUseOcrBridge(
          mod.registerCoordOcrProvider as (provider: unknown) => void,
        );
        logger.info(
          "[vision] registered coord-OCR bridge into plugin-computeruse scene seam",
        );
      }
    } catch (err) {
      logger.debug(
        `[vision] plugin-computeruse OCR seam not available; running standalone (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  },
  async dispose(runtime) {
    const svc = runtime.getService<VisionService>(VisionService.serviceType);
    await svc?.stop();
  },
};

export default visionPlugin;
