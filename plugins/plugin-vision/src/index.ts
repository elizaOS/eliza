/**
 * Runtime plugin registration for vision services, actions, providers, routes,
 * OCR backends, and computeruse bridge providers.
 */

import type { Plugin } from "@elizaos/core";
import {
  isAndroidMobile,
  logger,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { visionAction } from "./action";
import { wireComputerUseOcrBridge } from "./computeruse-ocr-bridge";
import { OcrBridgeService } from "./ocr-bridge";
import { AndroidBridgeOcrService } from "./ocr-service-android-bridge";
import { LinuxTesseractOcrService } from "./ocr-service-linux-tesseract";
import { PaddleOcrService } from "./ocr-service-paddleocr";
import { WindowsMediaOcrService } from "./ocr-service-windows";
import {
  getOcrWithCoordsService,
  RapidOcrCoordAdapter,
  registerOcrWithCoordsService,
} from "./ocr-with-coords";
import { visionProvider } from "./provider";
import { visionRoutes } from "./routes";
import { ScreenCaptureBridgeService } from "./screen-capture-bridge";
import { VisionService } from "./service";
import { wireComputerUseSetOfMarksBridge } from "./set-of-marks-provider";

type LocalInferenceServicesModule = {
  registerVisionContextAugmenter?: (augmenter: unknown) => void;
};

const dynamicImport = (specifier: string) => import(specifier);

export const visionPlugin: Plugin = {
  name: "vision",
  description:
    "Provides visual perception through camera integration and scene analysis",
  services: [VisionService, ScreenCaptureBridgeService, OcrBridgeService],
  providers: [visionProvider],
  routes: visionRoutes,
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
      // Prefer the native OS OCR engine where available (zero LLM tokens,
      // NPU-accelerated): Windows.Media.Ocr on Windows; the classic tesseract
      // CLI on Linux when installed; otherwise the docTR / Apple-Vision chain.
      // Native providers can override via registerOcrWithCoordsService later.
      if (isAndroidMobile() && _runtime) {
        registerOcrWithCoordsService(new AndroidBridgeOcrService(_runtime));
      } else if (PaddleOcrService.isAvailable()) {
        // Opt-in alternate engine (#9581): ELIZA_VISION_OCR_BACKEND=paddleocr.
        // Cross-platform; only selected when explicitly requested so it never
        // displaces a verified default provider.
        registerOcrWithCoordsService(new PaddleOcrService());
      } else if (WindowsMediaOcrService.isAvailable()) {
        registerOcrWithCoordsService(new WindowsMediaOcrService());
      } else if (LinuxTesseractOcrService.isAvailable()) {
        registerOcrWithCoordsService(new LinuxTesseractOcrService());
      } else {
        registerOcrWithCoordsService(new RapidOcrCoordAdapter());
      }
    }
    // Vision-context fusion (#9105): register an augmenter that runs OCR +
    // object/face detection over describe-image inputs and folds the results
    // into the Gemma-4 VL prompt. plugin-local-inference owns the registry; we
    // wire into it via a best-effort dynamic import (no hard dep — skipped
    // cleanly when local-inference is not installed), same as the OCR bridge.
    try {
      const li = (await dynamicImport(
        "@elizaos/plugin-local-inference/services",
      )) as LocalInferenceServicesModule;
      if (typeof li.registerVisionContextAugmenter === "function") {
        const { createDefaultVisionAugmenter } = await import(
          "./vision-context-augmenter.js"
        );
        li.registerVisionContextAugmenter(createDefaultVisionAugmenter());
        logger.info(
          "[vision] registered vision-context augmenter (OCR+object+face fusion) into IMAGE_DESCRIPTION",
        );
      }
    } catch (err) {
      logger.debug(
        `[vision] local-inference vision-augment seam not available; describe runs unaugmented (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }

    try {
      const mod = (await import(
        "@elizaos/plugin-computeruse/mobile/ocr-provider"
      )) as {
        registerCoordOcrProvider?: (provider: unknown) => void;
        registerSetOfMarksProvider?: (provider: unknown) => void;
      };
      if (typeof mod.registerCoordOcrProvider === "function") {
        wireComputerUseOcrBridge(
          mod.registerCoordOcrProvider as (provider: unknown) => void,
        );
        logger.info(
          "[vision] registered coord-OCR bridge into plugin-computeruse scene seam",
        );
      }
      // Set-of-Marks grounding (#9170 M9): fuse GGUF YOLO icons + OCR text into
      // numbered marks + overlay for computeruse's detect_elements.
      if (typeof mod.registerSetOfMarksProvider === "function") {
        wireComputerUseSetOfMarksBridge(
          mod.registerSetOfMarksProvider as (provider: unknown) => void,
        );
        logger.info(
          "[vision] registered Set-of-Marks bridge into plugin-computeruse detect_elements seam",
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
