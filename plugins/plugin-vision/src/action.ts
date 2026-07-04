/**
 * Vision action handler that routes structured sub-operations for capture,
 * describe, mode changes, entity naming, and screen element grounding.
 */

import {
  type Action,
  type ActionExample,
  type ActionResult,
  ContentType,
  createUniqueUuid,
  type HandlerCallback,
  type IAgentRuntime,
  isMobilePlatform,
  logger,
  type Media,
  type Memory,
  type State,
} from "@elizaos/core";
import { normalizeOp, normalizeVisionMode, VISION_OPS } from "./action-params";
import { buildGetScreen, summarizeGetScreen } from "./get-screen";
import { assertValidVisionImageBuffer } from "./image-input";
import {
  SCREEN_CAPTURE_BRIDGE_SERVICE_TYPE,
  type ScreenCaptureBridgeService,
} from "./screen-capture-bridge";
import type { VisionService } from "./service";
import { VisionMode } from "./types";

const VISION_ACTION_TIMEOUT_MS = 10_000;
const MAX_VISION_TEXT_LENGTH = 4000;
const MAX_VISION_ENTITIES = 25;

const ALL_VISION_CONTEXTS = [
  "media",
  "screen_time",
  "automation",
  "memory",
  "settings",
] as const;

function withVisionTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out`)),
        VISION_ACTION_TIMEOUT_MS,
      ),
    ),
  ]);
}

async function saveExecutionRecord(
  runtime: IAgentRuntime,
  messageContext: Memory,
  thought: string,
  text: string,
  actions?: string[],
  attachments?: Media[],
): Promise<void> {
  const memory: Memory = {
    id: createUniqueUuid(runtime, `vision-record-${Date.now()}`),
    content: {
      text,
      thought,
      actions: actions || ["VISION_ANALYSIS"],
      attachments,
    },
    entityId: createUniqueUuid(runtime, runtime.agentId),
    agentId: runtime.agentId,
    roomId: messageContext.roomId,
    worldId: messageContext.worldId,
    createdAt: Date.now(),
  };
  await runtime.createMemory(memory, "messages");
}

function readActionParams(
  options?: Record<string, unknown>,
): Record<string, unknown> {
  const direct =
    options && typeof options === "object"
      ? (options as Record<string, unknown>)
      : {};
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

function selectedContextMatches(
  state: State | undefined,
  contexts: readonly string[],
): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect(
    (state?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (state?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );
  const contextObject = (state?.data as Record<string, unknown> | undefined)
    ?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return contexts.some((context) => selected.has(context));
}

function visionServiceIsActive(runtime: IAgentRuntime): boolean {
  const visionService = runtime.getService<VisionService>("VISION");
  return Boolean(visionService?.isActive());
}

/** Structural view of plugin-computeruse's screenshot capability (no hard dep). */
interface ComputerUseLike {
  executeCommand?: (
    command: string,
    params?: Record<string, unknown>,
  ) => Promise<{ success?: boolean; screenshot?: string; displayId?: number }>;
}

/**
 * Acquire a fresh screen frame for GET_SCREEN. Prefers plugin-computeruse's
 * verified OS screenshot (which also drives the CUA loop); falls back to the
 * vision service's own screen capture. Returns null when neither is available.
 *
 * On mobile the agent has no desktop capture sources; the renderer-pulled
 * ScreenCaptureBridgeService is the ONLY source (the renderer polls, captures
 * via the Capacitor ScreenCapture MediaProjection plugin, and POSTs the frame
 * back). Return its result directly — do not fall through to desktop sources.
 */
async function acquireScreenFrame(runtime: IAgentRuntime): Promise<{
  pngBytes: Uint8Array;
  displayId: number;
  capturedAt: number;
} | null> {
  if (isMobilePlatform()) {
    const bridge = runtime.getService<ScreenCaptureBridgeService>(
      SCREEN_CAPTURE_BRIDGE_SERVICE_TYPE,
    );
    return bridge ? await bridge.requestFrame() : null;
  }
  const cu = runtime.getService("computeruse") as ComputerUseLike | null;
  if (cu?.executeCommand) {
    try {
      const r = await cu.executeCommand("screenshot");
      if (
        r?.success !== false &&
        typeof r?.screenshot === "string" &&
        r.screenshot
      ) {
        return {
          pngBytes: new Uint8Array(Buffer.from(r.screenshot, "base64")),
          displayId: typeof r.displayId === "number" ? r.displayId : 0,
          capturedAt: Date.now(),
        };
      }
    } catch (err) {
      logger.debug(
        `[vision] computeruse screenshot unavailable for get_screen (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }
  const visionService = runtime.getService<VisionService>("VISION");
  const cap = await visionService?.getScreenCapture();
  if (cap?.data && cap.data.byteLength > 0) {
    return {
      pngBytes: new Uint8Array(cap.data),
      displayId: 0,
      capturedAt: cap.timestamp ?? Date.now(),
    };
  }
  return null;
}

async function runGetScreen(
  runtime: IAgentRuntime,
  message: Memory,
  options: Record<string, unknown>,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const includeImage = options.includeImage === true;
  const includeOcr = options.includeOcr !== false;
  const displayId =
    typeof options.displayId === "number" ? options.displayId : undefined;

  const frame = await acquireScreenFrame(runtime);
  if (!frame) {
    const thought = "No screen capture source is available.";
    const text =
      "I couldn't read the screen — neither the desktop capture (plugin-computeruse) nor screen-vision mode is available right now.";
    await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
    if (callback) await callback({ thought, text, actions: ["VISION"] });
    return {
      success: false,
      text: "No screen capture source available for get_screen",
      values: { success: false, visionAvailable: false },
      data: {
        actionName: "VISION",
        op: "get_screen",
        error: "no_capture_source",
      },
    };
  }

  const result = await buildGetScreen({
    pngBytes: frame.pngBytes,
    displayId: displayId ?? frame.displayId,
    includeImage,
    includeOcr,
    capturedAt: frame.capturedAt,
  });
  const text = summarizeGetScreen(result);
  await saveExecutionRecord(runtime, message, text, text, ["VISION"]);
  if (callback) await callback({ thought: text, text, actions: ["VISION"] });
  return {
    success: true,
    text,
    values: {
      success: true,
      visionAvailable: true,
      ocrAvailable: result.ocrAvailable,
      elementCount: result.elementCount,
      width: result.width,
      height: result.height,
    },
    data: { actionName: "VISION", ...result },
  };
}

async function runDescribe(
  runtime: IAgentRuntime,
  message: Memory,
  options: Record<string, unknown>,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const visionService = runtime.getService<VisionService>("VISION");

  if (!visionService?.isActive()) {
    const thought =
      "Vision service is not available or no camera is connected.";
    const text = "I cannot see anything right now. No camera is available.";
    await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
    if (callback) {
      await callback({ thought, text, actions: ["VISION"] });
    }
    return {
      success: false,
      text: "Vision service unavailable - cannot analyze scene",
      values: {
        success: false,
        visionAvailable: false,
        error: "Vision service not available",
      },
      data: {
        actionName: "VISION",
        op: "describe",
        error: "Vision service not available or no camera connected",
      },
    };
  }

  try {
    const scene = await withVisionTimeout(
      visionService.getSceneDescription(),
      "vision scene description",
    );
    const cameraInfo = visionService.getCameraInfo();

    if (!scene) {
      const thought = "Camera is connected but no scene has been analyzed yet.";
      const text = `Camera "${cameraInfo?.name}" is connected, but I haven't analyzed any scenes yet. Please wait a moment.`;
      await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
      if (callback) {
        await callback({ thought, text, actions: ["VISION"] });
      }
      return {
        success: false,
        text: "Camera connected but no scene analyzed yet",
        values: {
          success: false,
          visionAvailable: true,
          sceneAnalyzed: false,
          cameraName: cameraInfo?.name || undefined,
        },
        data: {
          actionName: "VISION",
          op: "describe",
          cameraInfo: cameraInfo
            ? {
                id: cameraInfo.id,
                name: cameraInfo.name,
                connected: cameraInfo.connected,
              }
            : undefined,
          sceneStatus: "not_analyzed",
        },
      };
    }

    const peopleCount = scene.people.length;
    const objectCount = scene.objects.length;
    const people = scene.people.slice(0, MAX_VISION_ENTITIES);
    const objects = scene.objects.slice(0, MAX_VISION_ENTITIES);
    const timestamp = new Date(scene.timestamp).toLocaleString();
    const detailLevel =
      options.detailLevel === "summary" ? "summary" : "detailed";

    let description = `Looking through ${cameraInfo?.name || "the camera"}, `;
    description += scene.description;

    if (detailLevel === "detailed" && peopleCount > 0) {
      description += `\n\nI can see ${peopleCount} ${peopleCount === 1 ? "person" : "people"}`;
      const facingData = people.reduce(
        (acc, person) => {
          if (person.facing && person.facing !== "unknown") {
            acc[person.facing] = (acc[person.facing] || 0) + 1;
          }
          return acc;
        },
        {} as Record<string, number>,
      );

      if (Object.keys(facingData).length > 0) {
        const facingDescriptions = Object.entries(facingData).map(
          ([direction, count]) => `${count} facing ${direction}`,
        );
        description += ` (${facingDescriptions.join(", ")})`;
      }
      description += ".";
    }

    if (detailLevel === "detailed" && objectCount > 0) {
      const objectTypes = objects.reduce(
        (acc, obj) => {
          acc[obj.type] = (acc[obj.type] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      const objectDescriptions = Object.entries(objectTypes).map(
        ([type, count]) => `${count} ${type}${count > 1 ? "s" : ""}`,
      );
      description += `\n\nObjects detected: ${objectDescriptions.join(", ")}.`;
    }

    if (
      detailLevel === "detailed" &&
      scene.sceneChanged &&
      scene.changePercentage
    ) {
      description += `\n\n(Scene changed by ${scene.changePercentage.toFixed(1)}% since last analysis)`;
    }

    const thought = `Analyzed the visual scene at ${timestamp}.`;
    const text = description.slice(0, MAX_VISION_TEXT_LENGTH);

    await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
    if (callback) {
      await callback({ thought, text, actions: ["VISION"] });
    }

    return {
      success: true,
      text,
      values: {
        success: true,
        visionAvailable: true,
        sceneAnalyzed: true,
        peopleCount,
        objectCount,
        cameraName: cameraInfo?.name || undefined,
        sceneChanged: scene.sceneChanged,
        changePercentage: scene.changePercentage,
        detailLevel,
      },
      data: {
        actionName: "VISION",
        op: "describe",
        sceneTimestamp: scene.timestamp,
        sceneDescription: scene.description.slice(0, MAX_VISION_TEXT_LENGTH),
        sceneChanged: scene.sceneChanged,
        changePercentage: scene.changePercentage,
        audioTranscription: scene.audioTranscription || undefined,
        objectCount: objects.length,
        peopleCount: people.length,
        cameraInfo: cameraInfo
          ? {
              id: cameraInfo.id,
              name: cameraInfo.name,
              connected: cameraInfo.connected,
            }
          : undefined,
        timestamp,
        description: text,
      },
    };
  } catch (error: unknown) {
    logger.error(
      "[VISION/describe] Error analyzing scene:",
      error instanceof Error ? error.message : String(error),
    );
    const thought =
      "An error occurred while trying to analyze the visual scene.";
    const text = `Error analyzing scene: ${error instanceof Error ? error.message : String(error)}`;
    await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
    if (callback) {
      await callback({ thought, text, actions: ["VISION"] });
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      text: "Error analyzing scene",
      values: {
        success: false,
        visionAvailable: true,
        error: true,
        errorMessage,
      },
      data: {
        actionName: "VISION",
        op: "describe",
        error: errorMessage,
        errorType: "analysis_error",
      },
    };
  }
}

async function runCapture(
  runtime: IAgentRuntime,
  message: Memory,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const visionService = runtime.getService<VisionService>("VISION");

  if (!visionService?.isActive()) {
    const thought =
      "Vision service is not available or no camera is connected.";
    const text = "I cannot capture an image right now. No camera is available.";
    await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
    if (callback) {
      await callback({ thought, text, actions: ["VISION"] });
    }
    return {
      success: false,
      text: "Vision service unavailable - cannot capture image",
      values: {
        success: false,
        visionAvailable: false,
        error: "Vision service not available",
      },
      data: {
        actionName: "VISION",
        op: "capture",
        error: "Vision service not available or no camera connected",
      },
    };
  }

  try {
    const imageBuffer = await Promise.race([
      visionService.captureImage(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("vision capture timed out")),
          VISION_ACTION_TIMEOUT_MS,
        ),
      ),
    ]);
    const cameraInfo = visionService.getCameraInfo();

    if (!imageBuffer) {
      const thought = "Failed to capture image from camera.";
      const text =
        "I could not capture an image from the camera. Please try again.";
      await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
      if (callback) {
        await callback({ thought, text, actions: ["VISION"] });
      }
      return {
        success: false,
        text: "Failed to capture image from camera",
        values: {
          success: false,
          visionAvailable: true,
          captureSuccess: false,
        },
        data: {
          actionName: "VISION",
          op: "capture",
          error: "Camera capture failed",
          cameraInfo: cameraInfo
            ? {
                id: cameraInfo.id,
                name: cameraInfo.name,
                connected: cameraInfo.connected,
              }
            : undefined,
        },
      };
    }

    const imageInfo = await assertValidVisionImageBuffer(imageBuffer);
    const attachmentId = createUniqueUuid(runtime, `capture-${Date.now()}`);
    const timestamp = new Date().toISOString();

    const imageAttachment: Media = {
      id: attachmentId,
      title: `Camera Capture - ${timestamp}`,
      contentType: ContentType.IMAGE,
      source: `camera:${cameraInfo?.name || "unknown"}`,
      url: `data:${imageInfo.contentType};base64,${imageBuffer.toString("base64")}`,
    };

    const thought = `Captured an image from camera "${cameraInfo?.name}".`;
    const text = `I've captured an image from the camera at ${timestamp}.`;

    await saveExecutionRecord(
      runtime,
      message,
      thought,
      text,
      ["VISION"],
      [imageAttachment],
    );

    if (callback) {
      await callback({
        thought,
        text,
        actions: ["VISION"],
        attachments: [imageAttachment],
      });
    }

    return {
      success: true,
      text: `I've captured an image from the camera at ${timestamp}.`,
      values: {
        success: true,
        visionAvailable: true,
        captureSuccess: true,
        cameraName: cameraInfo?.name || undefined,
        timestamp,
      },
      data: {
        actionName: "VISION",
        op: "capture",
        imageAttachment: {
          id: imageAttachment.id,
          title: imageAttachment.title,
          contentType: imageAttachment.contentType,
          source: imageAttachment.source,
          url: imageAttachment.url,
        },
        cameraInfo: cameraInfo
          ? {
              id: cameraInfo.id,
              name: cameraInfo.name,
              connected: cameraInfo.connected,
            }
          : undefined,
        timestamp,
      },
    };
  } catch (error) {
    logger.error({ error }, "[VISION/capture] Error capturing image:");
    const thought = "An error occurred while trying to capture an image.";
    const errorMessage = error instanceof Error ? error.message : String(error);
    const text = `Error capturing image: ${errorMessage}`;
    await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
    if (callback) {
      await callback({ thought, text, actions: ["VISION"] });
    }

    return {
      success: false,
      text: "Error capturing image",
      values: {
        success: false,
        visionAvailable: true,
        error: true,
        errorMessage,
      },
      data: {
        actionName: "VISION",
        op: "capture",
        error: errorMessage,
        errorType: "capture_error",
      },
    };
  }
}

async function runToggleSubMode(
  runtime: IAgentRuntime,
  _message: Memory,
  op: "enable_camera" | "disable_camera" | "enable_screen" | "disable_screen",
  options: Record<string, unknown>,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const visionService = runtime.getService<VisionService>("VISION");
  if (!visionService) {
    const text = "Vision service is not available.";
    if (callback) await callback({ text, actions: ["VISION"] });
    return { success: false, text, data: { actionName: "VISION", op } };
  }
  try {
    const before = visionService.getVisionMode();
    if (op === "enable_camera") {
      await visionService.enableCamera();
    } else if (op === "disable_camera") {
      await visionService.disableCamera();
    } else if (op === "enable_screen") {
      const displayIds = Array.isArray(options.displayIds)
        ? (options.displayIds as unknown[])
            .map((v) => (typeof v === "number" ? v : Number(v)))
            .filter((v) => Number.isFinite(v))
        : undefined;
      await visionService.enableScreen(displayIds);
    } else {
      await visionService.disableScreen();
    }
    const after = visionService.getVisionMode();
    const text = `Vision mode: ${before} -> ${after} (${op})`;
    if (callback) await callback({ text, actions: ["VISION"] });
    return {
      success: true,
      text,
      values: { visionMode: after, previousMode: before, op },
      data: {
        actionName: "VISION",
        op,
        visionMode: after,
        previousMode: before,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[VISION/${op}] error:`, errorMessage);
    if (callback) {
      await callback({
        text: `Failed to ${op}: ${errorMessage}`,
        actions: ["VISION"],
      });
    }
    return {
      success: false,
      text: `Failed to ${op}`,
      error: errorMessage,
      data: { actionName: "VISION", op, error: errorMessage },
    };
  }
}

async function runSetMode(
  runtime: IAgentRuntime,
  message: Memory,
  options: Record<string, unknown>,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const visionService = runtime.getService<VisionService>("VISION");

  if (!visionService) {
    const thought = "Vision service is not available.";
    const text =
      "I cannot change vision mode because the vision service is not available.";
    await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
    if (callback) {
      await callback({ thought, text, actions: ["VISION"] });
    }
    return {
      success: false,
      text,
      data: { actionName: "VISION", op: "set_mode" },
    };
  }

  try {
    // #10471: the mode comes from the structured `mode` param, matched exactly
    // against the VisionMode enum — never a substring test on message text.
    const newMode = normalizeVisionMode(options.mode);

    if (!newMode) {
      const thought =
        "Could not determine the desired vision mode from the message.";
      const text =
        "Please specify the vision mode: OFF, CAMERA, SCREEN, or BOTH.";
      await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
      if (callback) {
        await callback({ thought, text, actions: ["VISION"] });
      }
      return {
        success: false,
        text,
        data: { actionName: "VISION", op: "set_mode" },
      };
    }

    const currentMode = visionService.getVisionMode();
    await Promise.race([
      visionService.setVisionMode(newMode),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("vision mode change timed out")),
          VISION_ACTION_TIMEOUT_MS,
        ),
      ),
    ]);

    const thought = `Changed vision mode from ${currentMode} to ${newMode}.`;
    let text = "";

    switch (newMode) {
      case VisionMode.OFF:
        text =
          "Vision has been disabled. I will no longer process visual input.";
        break;
      case VisionMode.CAMERA:
        text =
          "Vision mode set to CAMERA only. I will process input from the camera.";
        break;
      case VisionMode.SCREEN:
        text =
          "Vision mode set to SCREEN only. I will analyze what's on your screen.";
        break;
      case VisionMode.BOTH:
        text =
          "Vision mode set to BOTH. I will process input from both camera and screen.";
        break;
    }

    await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
    if (callback) {
      await callback({ thought, text, actions: ["VISION"] });
    }
    return {
      success: true,
      text,
      values: { visionMode: newMode },
      data: { actionName: "VISION", op: "set_mode", visionMode: newMode },
    };
  } catch (error) {
    logger.error({ error }, "[VISION/set_mode] Error changing vision mode:");
    const errorMessage = error instanceof Error ? error.message : String(error);
    const thought = "An error occurred while trying to change the vision mode.";
    const text = `Error changing vision mode: ${errorMessage}`;
    await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
    if (callback) {
      await callback({ thought, text, actions: ["VISION"] });
    }
    return {
      success: false,
      text,
      error: errorMessage,
      data: { actionName: "VISION", op: "set_mode" },
    };
  }
}

async function runNameEntity(
  runtime: IAgentRuntime,
  message: Memory,
  options: Record<string, unknown>,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  try {
    const visionService = runtime.getService<VisionService>("VISION");

    if (!visionService) {
      const thought = "Vision service is not available.";
      const text =
        "I cannot name entities because the vision service is not available.";
      await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
      if (callback) {
        await callback({ thought, text, actions: ["VISION"] });
      }
      return {
        success: false,
        text,
        data: { actionName: "VISION", op: "name_entity" },
      };
    }

    const scene = await withVisionTimeout(
      visionService.getSceneDescription(),
      "vision scene description",
    );

    if (!scene || scene.people.length === 0) {
      const thought = "No people visible to name.";
      const text = "I don't see any people in the current scene to name.";
      await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
      if (callback) {
        await callback({ thought, text, actions: ["VISION"] });
      }
      return {
        success: false,
        text,
        data: { actionName: "VISION", op: "name_entity" },
      };
    }

    // #10471: the entity name comes from the structured `name` param, not a
    // regex over the raw message text.
    const name = typeof options.name === "string" ? options.name.trim() : "";

    if (!name) {
      const thought = "No structured name parameter was provided.";
      const text =
        'I couldn\'t understand what name to assign. Provide a "name" parameter (e.g. name: "Alice").';
      await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
      if (callback) {
        await callback({ thought, text, actions: ["VISION"] });
      }
      return {
        success: false,
        text,
        data: { actionName: "VISION", op: "name_entity" },
      };
    }

    const entityTracker = visionService.getEntityTracker();

    await entityTracker.updateEntities(
      scene.objects.slice(0, MAX_VISION_ENTITIES),
      scene.people.slice(0, MAX_VISION_ENTITIES),
      undefined,
      runtime,
    );
    const activeEntities = entityTracker.getActiveEntities();
    const people = activeEntities.filter((e) => e.entityType === "person");

    if (people.length === 0) {
      const thought = "No tracked people found.";
      const text =
        "I can see someone but haven't established tracking yet. Please try again in a moment.";
      await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
      if (callback) {
        await callback({ thought, text, actions: ["VISION"] });
      }
      return {
        success: false,
        text,
        data: { actionName: "VISION", op: "name_entity" },
      };
    }

    let targetPerson = people[0];
    if (people.length > 1) {
      targetPerson = people.reduce((prev, curr) => {
        const prevArea = prev.lastPosition.width * prev.lastPosition.height;
        const currArea = curr.lastPosition.width * curr.lastPosition.height;
        return currArea > prevArea ? curr : prev;
      });
    }

    const success = entityTracker.assignNameToEntity(targetPerson.id, name);

    if (success) {
      const thought = `Named entity "${name}" and associated with person in scene.`;
      const text = `I've identified the person as ${name}. I'll remember them for future interactions.`;

      await saveExecutionRecord(
        runtime,
        message,
        thought,
        text,
        ["VISION"],
        undefined,
      );

      if (callback) {
        await callback({
          thought,
          text,
          actions: ["VISION"],
          data: { entityId: targetPerson.id, name },
        });
      }

      logger.info(
        `[VISION/name_entity] Assigned name "${name}" to entity ${targetPerson.id}`,
      );
      return {
        success: true,
        text,
        values: { entityId: targetPerson.id, name },
        data: {
          actionName: "VISION",
          op: "name_entity",
          entityId: targetPerson.id,
          name,
        },
      };
    } else {
      const thought = "Failed to assign name to entity.";
      const text = "There was an error assigning the name. Please try again.";
      await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
      if (callback) {
        await callback({ thought, text, actions: ["VISION"] });
      }
      return {
        success: false,
        text,
        data: { actionName: "VISION", op: "name_entity" },
      };
    }
  } catch (error) {
    logger.error({ error }, "[VISION/name_entity] Error:");
    const thought = "Failed to name entity.";
    const text = `Sorry, I couldn't name the entity: ${error instanceof Error ? error.message : "Unknown error"}`;
    await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
    if (callback) {
      await callback({ thought, text, actions: ["VISION"] });
    }
    return {
      success: false,
      text,
      error: error instanceof Error ? error.message : String(error),
      data: { actionName: "VISION", op: "name_entity" },
    };
  }
}

async function runIdentifyPerson(
  runtime: IAgentRuntime,
  message: Memory,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  try {
    const visionService = runtime.getService<VisionService>("VISION");

    if (!visionService) {
      const thought = "Vision service is not available.";
      const text =
        "I cannot identify people because the vision service is not available.";
      await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
      if (callback) {
        await callback({ thought, text, actions: ["VISION"] });
      }
      return {
        success: false,
        text,
        data: { actionName: "VISION", op: "identify_person" },
      };
    }

    const scene = await withVisionTimeout(
      visionService.getSceneDescription(),
      "vision scene description",
    );

    if (!scene || scene.people.length === 0) {
      const thought = "No people visible to identify.";
      const text = "I don't see any people in the current scene.";
      await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
      if (callback) {
        await callback({ thought, text, actions: ["VISION"] });
      }
      return {
        success: false,
        text,
        data: { actionName: "VISION", op: "identify_person" },
      };
    }

    const entityTracker = visionService.getEntityTracker();

    await entityTracker.updateEntities(
      scene.objects.slice(0, MAX_VISION_ENTITIES),
      scene.people.slice(0, MAX_VISION_ENTITIES),
      undefined,
      runtime,
    );
    const activeEntities = entityTracker.getActiveEntities();
    const people = activeEntities.filter((e) => e.entityType === "person");

    if (people.length === 0) {
      const thought = "No tracked people found.";
      const text = "I can see someone but I'm still processing their identity.";
      await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
      if (callback) {
        await callback({ thought, text, actions: ["VISION"] });
      }
      return {
        success: false,
        text,
        data: { actionName: "VISION", op: "identify_person" },
      };
    }

    let recognizedCount = 0;
    let unknownCount = 0;
    const identifications: string[] = [];

    for (const person of people) {
      const name = person.attributes.name;
      const duration = Date.now() - person.firstSeen;
      const durationStr =
        duration < 60000
          ? `${Math.round(duration / 1000)} seconds`
          : `${Math.round(duration / 60000)} minutes`;

      if (name) {
        recognizedCount++;
        const personInfo = `I can see ${name}. They've been here for ${durationStr}.`;
        identifications.push(personInfo);

        if (person.appearances.length > 5) {
          identifications.push("I've been tracking them consistently.");
        }
      } else {
        unknownCount++;
        const personInfo = `I see an unidentified person who has been here for ${durationStr}.`;
        identifications.push(personInfo);

        if (person.attributes.faceId) {
          identifications.push(
            "I've captured their face profile but they haven't been named yet.",
          );
        }
      }
    }

    const recentlyLeft = entityTracker.getRecentlyLeft();
    if (recentlyLeft.length > 0) {
      identifications.push("\nRecently departed:");
      for (const { entity, leftAt } of recentlyLeft) {
        if (entity.entityType === "person" && entity.attributes.name) {
          const timeAgo = Date.now() - leftAt;
          const timeStr =
            timeAgo < 60000
              ? `${Math.round(timeAgo / 1000)} seconds ago`
              : `${Math.round(timeAgo / 60000)} minutes ago`;
          identifications.push(`${entity.attributes.name} left ${timeStr}.`);
        }
      }
    }

    const thought = `Identified ${recognizedCount} known people and ${unknownCount} unknown people.`;
    const text = identifications.join(" ");

    await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);

    if (callback) {
      await callback({
        thought,
        text,
        actions: ["VISION"],
        data: {
          identifications: people.slice(0, MAX_VISION_ENTITIES).map((p) => ({
            id: p.id,
            entityType: p.entityType,
            name: p.attributes.name || undefined,
          })),
        },
      });
    }
    return {
      success: true,
      text,
      values: { recognizedCount, unknownCount },
      data: {
        actionName: "VISION",
        op: "identify_person",
        recognizedCount,
        unknownCount,
      },
    };
  } catch (error) {
    logger.error({ error }, "[VISION/identify_person] Error:");
    const thought = "Failed to identify people.";
    const text = `Sorry, I couldn't identify people: ${error instanceof Error ? error.message : "Unknown error"}`;
    await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
    if (callback) {
      await callback({ thought, text, actions: ["VISION"] });
    }
    return {
      success: false,
      text,
      error: error instanceof Error ? error.message : String(error),
      data: { actionName: "VISION", op: "identify_person" },
    };
  }
}

async function runTrackEntity(
  runtime: IAgentRuntime,
  message: Memory,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  try {
    const visionService = runtime.getService<VisionService>("VISION");

    if (!visionService) {
      const thought = "Vision service is not available.";
      const text =
        "I cannot track entities because the vision service is not available.";
      await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
      if (callback) {
        await callback({ thought, text, actions: ["VISION"] });
      }
      return {
        success: false,
        text,
        data: { actionName: "VISION", op: "track_entity" },
      };
    }

    const scene = await withVisionTimeout(
      visionService.getSceneDescription(),
      "vision scene description",
    );

    if (!scene) {
      const thought = "No scene available for tracking.";
      const text =
        "I need a moment to process the visual scene before I can track entities.";
      await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
      if (callback) {
        await callback({ thought, text, actions: ["VISION"] });
      }
      return {
        success: false,
        text,
        data: { actionName: "VISION", op: "track_entity" },
      };
    }

    const entityTracker = visionService.getEntityTracker();
    await entityTracker.updateEntities(
      scene.objects.slice(0, MAX_VISION_ENTITIES),
      scene.people.slice(0, MAX_VISION_ENTITIES),
      undefined,
      runtime,
    );
    const stats = entityTracker.getStatistics();

    const thought = `Tracking ${stats.activeEntities} entities in the scene.`;
    const summary = [
      `I'm now tracking ${stats.activeEntities} entities in the scene`,
      `(${stats.people} people, ${stats.objects} objects).`,
      "The visual tracking system will maintain persistent IDs for all entities",
      "and notify you of significant changes.",
    ];
    const responseText = summary.join(" ");

    await saveExecutionRecord(runtime, message, thought, responseText, [
      "VISION",
    ]);

    if (callback) {
      await callback({
        thought,
        text: responseText,
        actions: ["VISION"],
        data: { entities: stats.activeEntities },
      });
    }

    logger.info(
      `[VISION/track_entity] Tracking ${stats.activeEntities} entities`,
    );
    return {
      success: true,
      text: responseText,
      values: {
        activeEntities: stats.activeEntities,
        people: stats.people,
        objects: stats.objects,
      },
      data: {
        actionName: "VISION",
        op: "track_entity",
        activeEntities: stats.activeEntities,
        people: stats.people,
        objects: stats.objects,
      },
    };
  } catch (error) {
    logger.error({ error }, "[VISION/track_entity] Error:");
    const thought = "Failed to track entities.";
    const text = `Sorry, I couldn't track entities: ${error instanceof Error ? error.message : "Unknown error"}`;
    await saveExecutionRecord(runtime, message, thought, text, ["VISION"]);
    if (callback) {
      await callback({ thought, text, actions: ["VISION"] });
    }
    return {
      success: false,
      text,
      error: error instanceof Error ? error.message : String(error),
      data: { actionName: "VISION", op: "track_entity" },
    };
  }
}

export const visionAction: Action = {
  name: "VISION",
  contexts: [...ALL_VISION_CONTEXTS],
  contextGate: { anyOf: [...ALL_VISION_CONTEXTS] },
  roleGate: { minRole: "USER" },
  similes: [
    "DESCRIBE_SCENE",
    "CAPTURE_IMAGE",
    "SET_VISION_MODE",
    "NAME_ENTITY",
    "IDENTIFY_PERSON",
    "TRACK_ENTITY",
    "ANALYZE_SCENE",
    "WHAT_DO_YOU_SEE",
    "VISION_CHECK",
    "LOOK_AROUND",
    "TAKE_PHOTO",
    "SCREENSHOT",
    "CAPTURE_FRAME",
    "TAKE_PICTURE",
    "GET_SCREEN",
    "READ_SCREEN",
    "SCREEN_TEXT",
    "OCR_SCREEN",
  ],
  description:
    "Camera and screen vision: describe the current scene, capture an image, GET_SCREEN (token-frugal structured readout — OCR text + grounded UI elements with coordinates, no image unless includeImage=true), switch vision mode (off/camera/screen/both), name a visible entity, identify a person, or start tracking an entity. The action is inferred from the message text when not explicitly provided.",
  descriptionCompressed:
    "Vision: describe / capture / get_screen (OCR+elements, no image) / set_mode / name_entity / identify_person / track_entity.",
  parameters: [
    {
      name: "action",
      description:
        "Operation to perform: describe, capture, set_mode, name_entity, identify_person, or track_entity. Inferred from message text when omitted.",
      required: false,
      schema: { type: "string", enum: [...VISION_OPS] },
    },
    {
      name: "subaction",
      description: "Legacy alias for action.",
      required: false,
      schema: { type: "string", enum: [...VISION_OPS] },
    },
    {
      name: "detailLevel",
      description:
        "For action=describe: 'summary' to omit object/person breakdowns, 'detailed' for the full breakdown.",
      required: false,
      schema: {
        type: "string",
        enum: ["summary", "detailed"],
        default: "detailed",
      },
    },
    {
      name: "includeImage",
      description:
        "For action=get_screen: when true, attach the base64 screenshot too (costs image tokens). Default false — return only OCR text + grounded elements.",
      required: false,
      schema: { type: "boolean", default: false },
    },
    {
      name: "mode",
      description:
        "For action=set_mode: vision mode to set: off, camera, screen, or both.",
      required: false,
      schema: { type: "string", enum: ["off", "camera", "screen", "both"] },
    },
    {
      name: "name",
      description:
        "For action=name_entity: the name to assign to the most relevant visible person or object.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "targetHint",
      description:
        "For action=name_entity or action=identify_person: optional phrase describing which visible entity to focus on.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "description",
      description:
        "For action=track_entity: optional description of the visible entity to prioritize for tracking.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "includeUnknown",
      description:
        "For action=identify_person: whether to mention unidentified people in the response.",
      required: false,
      schema: { type: "boolean", default: true },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    options?: Record<string, unknown>,
  ): Promise<boolean> => {
    if (!visionServiceIsActive(runtime)) {
      // set_mode does not require active vision; allow if service is registered.
      const visionService = runtime.getService<VisionService>("VISION");
      if (!visionService) return false;
    }
    const params = readActionParams(options);
    return (
      selectedContextMatches(state, ALL_VISION_CONTEXTS) ||
      typeof params.action === "string" ||
      typeof params.op === "string" ||
      typeof params.subaction === "string"
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult> => {
    const params = readActionParams(_options);
    // #10471: the operation comes from the planner's structured discriminator,
    // never from English keyword-matching the raw message text.
    const inferredOp = normalizeOp(
      params.action ?? params.subaction ?? params.op,
    );

    if (!inferredOp) {
      const text = `VISION could not determine the operation. Specify one of: ${VISION_OPS.join(", ")}.`;
      if (callback) {
        await callback({ text, actions: ["VISION"] });
      }
      return {
        success: false,
        text,
        values: { error: "MISSING" },
        data: {
          actionName: "VISION",
          availableOps: VISION_OPS,
        },
      };
    }

    switch (inferredOp) {
      case "describe":
        return runDescribe(runtime, message, params, callback);
      case "capture":
        return runCapture(runtime, message, callback);
      case "get_screen":
        return runGetScreen(runtime, message, params, callback);
      case "set_mode":
        return runSetMode(runtime, message, params, callback);
      case "enable_camera":
      case "disable_camera":
      case "enable_screen":
      case "disable_screen":
        return runToggleSubMode(runtime, message, inferredOp, params, callback);
      case "name_entity":
        return runNameEntity(runtime, message, params, callback);
      case "identify_person":
        return runIdentifyPerson(runtime, message, callback);
      case "track_entity":
        return runTrackEntity(runtime, message, callback);
    }
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "what do you see?" } },
      {
        name: "{{agent}}",
        content: {
          actions: ["VISION"],
          thought: "The user wants to know what I can see through my camera.",
          text: "I see a room with a desk and computer setup. There are 2 people, one is sitting and one is standing.",
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "take a photo" } },
      {
        name: "{{agent}}",
        content: {
          actions: ["VISION"],
          thought: "The user wants me to capture an image from the camera.",
          text: "I've captured an image from the camera.",
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "set vision mode to screen" } },
      {
        name: "{{agent}}",
        content: {
          actions: ["VISION"],
          thought: "The user wants to switch to screen vision mode.",
          text: "Vision mode set to SCREEN only. I will analyze what's on your screen.",
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "the person wearing the blue shirt is named Alice" },
      },
      {
        name: "{{agent}}",
        content: {
          actions: ["VISION"],
          text: "I've identified the person in the blue shirt as Alice. I'll remember them for future interactions.",
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "who is the person in front of you?" },
      },
      {
        name: "{{agent}}",
        content: {
          actions: ["VISION"],
          text: "That's Alice. I last saw her about 5 minutes ago.",
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "track the person wearing the red shirt" },
      },
      {
        name: "{{agent}}",
        content: {
          actions: ["VISION"],
          text: "I'm now tracking the person in the red shirt.",
        },
      },
    ],
  ] as ActionExample[][],
};
