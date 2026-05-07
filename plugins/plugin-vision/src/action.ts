import {
  type Action,
  type ActionExample,
  type ActionResult,
  ContentType,
  createUniqueUuid,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Media,
  type Memory,
  type State,
} from "@elizaos/core";
import type { VisionService } from "./service";
import { VisionMode } from "./types";

const VISION_ACTION_TIMEOUT_MS = 10_000;
const MAX_VISION_TEXT_LENGTH = 4000;
const MAX_VISION_ENTITIES = 25;

function withVisionTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), VISION_ACTION_TIMEOUT_MS),
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

function hasVisionIntent(
  message: Memory,
  state: State | undefined,
  keywords: readonly string[],
): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string"
      ? state.values.recentMessages
      : "",
  ]
    .join("\n")
    .toLowerCase();
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function visionServiceIsActive(runtime: IAgentRuntime): boolean {
  const visionService = runtime.getService<VisionService>("VISION");
  return Boolean(visionService?.isActive());
}

function hasVisionContextOrIntent(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  contexts: readonly string[],
  keywords: readonly string[],
): boolean {
  return (
    visionServiceIsActive(runtime) &&
    (selectedContextMatches(state, contexts) ||
      hasVisionIntent(message, state, keywords))
  );
}

export const describeSceneAction: Action = {
  name: "DESCRIBE_SCENE",
  contexts: ["media", "screen_time", "automation"],
  contextGate: { anyOf: ["media", "screen_time", "automation"] },
  roleGate: { minRole: "USER" },
  similes: ["ANALYZE_SCENE", "WHAT_DO_YOU_SEE", "VISION_CHECK", "LOOK_AROUND"],
  description:
    "Analyzes the current visual scene and provides a detailed description of what the agent sees through the camera. Returns scene analysis data including people count, objects, and camera info for action chaining.",
  descriptionCompressed: "Describe what camera sees as natural language.",
  parameters: [
    {
      name: "detailLevel",
      description:
        "Scene description detail level. Use summary to omit object/person breakdowns from the spoken response.",
      required: false,
      schema: {
        type: "string",
        enum: ["summary", "detailed"],
        default: "detailed",
      },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> =>
    hasVisionContextOrIntent(
      runtime,
      message,
      state,
      ["media", "screen_time", "automation"],
      [
        "describe",
        "scene",
        "see",
        "look",
        "camera",
        "screen",
        "object",
        "person",
        "escena",
        "ver",
        "camara",
        "décrire",
        "scène",
        "voir",
        "beschreiben",
        "szene",
        "sehen",
        "descrivi",
        "scena",
        "vedi",
        "説明",
        "見える",
        "场景",
        "描述",
        "看见",
        "장면",
        "설명",
        "보여",
      ],
    ),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult> => {
    const visionService = runtime.getService<VisionService>("VISION");

    if (!visionService || !visionService.isActive()) {
      const thought =
        "Vision service is not available or no camera is connected.";
      const text = "I cannot see anything right now. No camera is available.";
      await saveExecutionRecord(runtime, message, thought, text, [
        "DESCRIBE_SCENE",
      ]);
      if (callback) {
        await callback({
          thought,
          text,
          actions: ["DESCRIBE_SCENE"],
        });
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
          actionName: "DESCRIBE_SCENE",
          error: "Vision service not available or no camera connected",
        },
      };
    }

    try {
      const maxVisionEntities = MAX_VISION_ENTITIES;
      const scene = await withVisionTimeout(
        visionService.getSceneDescription(),
        "vision scene description",
      );
      const cameraInfo = visionService.getCameraInfo();

      if (!scene) {
        const thought =
          "Camera is connected but no scene has been analyzed yet.";
        const text = `Camera "${cameraInfo?.name}" is connected, but I haven't analyzed any scenes yet. Please wait a moment.`;
        await saveExecutionRecord(runtime, message, thought, text, [
          "DESCRIBE_SCENE",
        ]);
        if (callback) {
          await callback({
            thought,
            text,
            actions: ["DESCRIBE_SCENE"],
          });
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
            actionName: "DESCRIBE_SCENE",
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
      const people = scene.people.slice(0, maxVisionEntities);
      const objects = scene.objects.slice(0, maxVisionEntities);
      const timestamp = new Date(scene.timestamp).toLocaleString();
      const detailLevel =
        readActionParams(_options).detailLevel === "summary"
          ? "summary"
          : "detailed";

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

      await saveExecutionRecord(runtime, message, thought, text, [
        "DESCRIBE_SCENE",
      ]);
      if (callback) {
        await callback({
          thought,
          text,
          actions: ["DESCRIBE_SCENE"],
        });
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
          actionName: "DESCRIBE_SCENE",
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
        "[describeSceneAction] Error analyzing scene:",
        error instanceof Error ? error.message : String(error),
      );
      const thought =
        "An error occurred while trying to analyze the visual scene.";
      const text = `Error analyzing scene: ${error instanceof Error ? error.message : String(error)}`;
      await saveExecutionRecord(runtime, message, thought, text, [
        "DESCRIBE_SCENE",
      ]);
      if (callback) {
        await callback({
          thought,
          text,
          actions: ["DESCRIBE_SCENE"],
        });
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
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
          actionName: "DESCRIBE_SCENE",
          error: errorMessage,
          errorType: "analysis_error",
        },
      };
    }
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "what do you see?" } },
      {
        name: "{{agent}}",
        content: {
          actions: ["DESCRIBE_SCENE"],
          thought: "The user wants to know what I can see through my camera.",
          text: "I see a room with a desk and computer setup. There are 2 people, one is sitting and one is standing.",
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "describe the scene and then take a photo" },
      },
      {
        name: "{{agent}}",
        content: {
          actions: ["DESCRIBE_SCENE", "CAPTURE_IMAGE"],
          thought:
            "I should first analyze the scene, then capture an image for the user.",
          text: "I can see 3 people in an office setting. Let me capture this scene for you.",
        },
      },
    ],
  ] as ActionExample[][],
};

export const captureImageAction: Action = {
  name: "CAPTURE_IMAGE",
  contexts: ["media", "screen_time", "automation"],
  contextGate: { anyOf: ["media", "screen_time", "automation"] },
  roleGate: { minRole: "USER" },
  similes: ["TAKE_PHOTO", "SCREENSHOT", "CAPTURE_FRAME", "TAKE_PICTURE"],
  description:
    "Captures the current frame from the camera and saves it as an image attachment. Returns image data with camera info and timestamp for action chaining. Can be combined with DESCRIBE_SCENE for analysis or NAME_ENTITY for identification workflows.",
  descriptionCompressed: "Take camera snapshot to memory.",
  parameters: [],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    return hasVisionContextOrIntent(
      runtime,
      message,
      state,
      ["media", "screen_time", "automation"],
      [
        "capture",
        "image",
        "photo",
        "picture",
        "snapshot",
        "screenshot",
        "camera",
        "captura",
        "foto",
        "imagen",
        "capturer",
        "photo",
        "bild",
        "foto",
        "capturare",
        "写真",
        "画像",
        "スクリーンショット",
        "拍照",
        "截图",
        "이미지",
        "사진",
        "스크린샷",
      ],
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
    const visionService = runtime.getService<VisionService>("VISION");

    if (!visionService || !visionService.isActive()) {
      const thought =
        "Vision service is not available or no camera is connected.";
      const text =
        "I cannot capture an image right now. No camera is available.";
      await saveExecutionRecord(runtime, message, thought, text, [
        "CAPTURE_IMAGE",
      ]);
      if (callback) {
        await callback({
          thought,
          text,
          actions: ["CAPTURE_IMAGE"],
        });
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
          actionName: "CAPTURE_IMAGE",
          error: "Vision service not available or no camera connected",
        },
      };
    }

    try {
      const timeoutMs = VISION_ACTION_TIMEOUT_MS;
      const imageBuffer = await Promise.race([
        visionService.captureImage(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("vision capture timed out")), timeoutMs),
        ),
      ]);
      const cameraInfo = visionService.getCameraInfo();

      if (!imageBuffer) {
        const thought = "Failed to capture image from camera.";
        const text =
          "I could not capture an image from the camera. Please try again.";
        await saveExecutionRecord(runtime, message, thought, text, [
          "CAPTURE_IMAGE",
        ]);
        if (callback) {
          await callback({
            thought,
            text,
            actions: ["CAPTURE_IMAGE"],
          });
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
            actionName: "CAPTURE_IMAGE",
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

      const attachmentId = createUniqueUuid(runtime, `capture-${Date.now()}`);
      const timestamp = new Date().toISOString();

      const imageAttachment: Media = {
        id: attachmentId,
        title: `Camera Capture - ${timestamp}`,
        contentType: ContentType.IMAGE,
        source: `camera:${cameraInfo?.name || "unknown"}`,
        url: `data:image/jpeg;base64,${imageBuffer.toString("base64")}`,
      };

      const thought = `Captured an image from camera "${cameraInfo?.name}".`;
      const text = `I've captured an image from the camera at ${timestamp}.`;

      await saveExecutionRecord(
        runtime,
        message,
        thought,
        text,
        ["CAPTURE_IMAGE"],
        [imageAttachment],
      );

      if (callback) {
        await callback({
          thought,
          text,
          actions: ["CAPTURE_IMAGE"],
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
          actionName: "CAPTURE_IMAGE",
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
      logger.error("[captureImageAction] Error capturing image:", error);
      const thought = "An error occurred while trying to capture an image.";
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const text = `Error capturing image: ${errorMessage}`;
      await saveExecutionRecord(runtime, message, thought, text, [
        "CAPTURE_IMAGE",
      ]);
      if (callback) {
        await callback({
          thought,
          text,
          actions: ["CAPTURE_IMAGE"],
        });
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
          actionName: "CAPTURE_IMAGE",
          error: errorMessage,
          errorType: "capture_error",
        },
      };
    }
  },
  examples: [
    // Multi-action: Describe scene then capture image
    [
      {
        name: "{{user}}",
        content: { text: "describe what you see and take a photo" },
      },
      {
        name: "{{agent}}",
        content: {
          actions: ["DESCRIBE_SCENE", "CAPTURE_IMAGE"],
          thought: "User wants scene analysis followed by image capture.",
          text: "I can see 3 people in an office setting. Let me capture this scene for you.",
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "take a photo" } },
      {
        name: "{{agent}}",
        content: {
          actions: ["CAPTURE_IMAGE"],
          thought: "The user wants me to capture an image from the camera.",
          text: "I've captured an image from the camera.",
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "capture the current scene" } },
      {
        name: "{{agent}}",
        content: {
          actions: ["CAPTURE_IMAGE"],
        },
      },
    ],
  ] as ActionExample[][],
};

export const setVisionModeAction: Action = {
  name: "SET_VISION_MODE",
  contexts: ["media", "screen_time", "settings"],
  contextGate: { anyOf: ["media", "screen_time", "settings"] },
  roleGate: { minRole: "USER" },
  description: "Set the vision mode to OFF, CAMERA, SCREEN, or BOTH",
  descriptionCompressed: "Set vision mode: face, scene, object, tracking.",
  similes: [
    "change vision to {mode}",
    "set vision mode {mode}",
    "switch to {mode} vision",
    "turn vision {mode}",
    "use {mode} vision",
    "enable {mode} vision",
    "disable vision",
  ],
  parameters: [
    {
      name: "mode",
      description: "Vision mode to set: off, camera, screen, or both.",
      required: false,
      schema: {
        type: "string",
        enum: ["off", "camera", "screen", "both"],
      },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> =>
    Boolean(runtime.getService<VisionService>("VISION")) &&
    (selectedContextMatches(state, ["media", "screen_time", "settings"]) ||
      hasVisionIntent(message, state, [
        "vision",
        "mode",
        "camera",
        "screen",
        "both",
        "disable",
        "enable",
        "off",
        "visión",
        "camara",
        "pantalla",
        "écran",
        "kamera",
        "bildschirm",
        "schermo",
        "ビジョン",
        "カメラ",
        "画面",
        "视觉",
        "相机",
        "屏幕",
        "비전",
        "카메라",
        "화면",
      ])),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult> => {
    const visionService = runtime.getService<VisionService>("VISION");

    if (!visionService) {
      const thought = "Vision service is not available.";
      const text =
        "I cannot change vision mode because the vision service is not available.";
      await saveExecutionRecord(runtime, message, thought, text, [
        "SET_VISION_MODE",
      ]);
      if (callback) {
        await callback({
          thought,
          text,
          actions: ["SET_VISION_MODE"],
        });
      }
      return {
        success: false,
        text,
      };
    }

    try {
      const params = readActionParams(_options);
      const explicitMode =
        typeof params.mode === "string" ? params.mode.toLowerCase() : "";
      const messageText =
        explicitMode || message.content.text?.toLowerCase() || "";
      let newMode: VisionMode | null = null;

      if (messageText.includes("off") || messageText.includes("disable")) {
        newMode = VisionMode.OFF;
      } else if (messageText.includes("both")) {
        newMode = VisionMode.BOTH;
      } else if (messageText.includes("screen")) {
        newMode = VisionMode.SCREEN;
      } else if (messageText.includes("camera")) {
        newMode = VisionMode.CAMERA;
      }

      if (!newMode) {
        const thought =
          "Could not determine the desired vision mode from the message.";
        const text =
          "Please specify the vision mode: OFF, CAMERA, SCREEN, or BOTH.";
        await saveExecutionRecord(runtime, message, thought, text, [
          "SET_VISION_MODE",
        ]);
        if (callback) {
          await callback({
            thought,
            text,
            actions: ["SET_VISION_MODE"],
          });
        }
        return {
          success: false,
          text,
        };
      }

      const currentMode = visionService.getVisionMode();
      const timeoutMs = VISION_ACTION_TIMEOUT_MS;
      await Promise.race([
        visionService.setVisionMode(newMode),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("vision mode change timed out")), timeoutMs),
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

      await saveExecutionRecord(runtime, message, thought, text, [
        "SET_VISION_MODE",
      ]);
      if (callback) {
        await callback({
          thought,
          text,
          actions: ["SET_VISION_MODE"],
        });
      }
      return {
        success: true,
        text,
        values: {
          visionMode: newMode,
        },
      };
    } catch (error) {
      logger.error("[setVisionModeAction] Error changing vision mode:", error);
      const thought =
        "An error occurred while trying to change the vision mode.";
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const text = `Error changing vision mode: ${errorMessage}`;
      await saveExecutionRecord(runtime, message, thought, text, [
        "SET_VISION_MODE",
      ]);
      if (callback) {
        await callback({
          thought,
          text,
          actions: ["SET_VISION_MODE"],
        });
      }
      return {
        success: false,
        text,
        error: errorMessage,
      };
    }
  },
  examples: [
    [
      { name: "user", content: { text: "set vision mode to screen" } },
      {
        name: "agent",
        content: {
          actions: ["SET_VISION_MODE"],
          thought: "The user wants to switch to screen vision mode.",
          text: "Vision mode set to SCREEN only. I will analyze what's on your screen.",
        },
      },
    ],
    [
      {
        name: "user",
        content: { text: "enable both camera and screen vision" },
      },
      {
        name: "agent",
        content: {
          actions: ["SET_VISION_MODE"],
          thought: "The user wants to enable both vision inputs.",
          text: "Vision mode set to BOTH. I will process input from both camera and screen.",
        },
      },
    ],
    [
      { name: "user", content: { text: "turn off vision" } },
      {
        name: "agent",
        content: {
          actions: ["SET_VISION_MODE"],
          thought: "The user wants to disable vision.",
          text: "Vision has been disabled. I will no longer process visual input.",
        },
      },
    ],
  ],
};

export const nameEntityAction: Action = {
  name: "NAME_ENTITY",
  contexts: ["media", "memory"],
  contextGate: { anyOf: ["media", "memory"] },
  roleGate: { minRole: "USER" },
  description:
    "Assign a name to a person or object currently visible in the camera view",
  descriptionCompressed: "Name a tracked entity by id.",
  similes: [
    "call the person {name}",
    "the person in front is {name}",
    "name the person {name}",
    "that person is {name}",
    "the object is a {name}",
    "call that {name}",
  ],
  parameters: [
    {
      name: "name",
      description:
        "Name to assign to the most relevant visible person or object.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "targetHint",
      description: "Optional phrase describing which visible entity to name.",
      required: false,
      schema: { type: "string" },
    },
  ],
  examples: [
    [
      {
        name: "user",
        content: {
          text: "The person wearing the blue shirt is named Alice",
        },
      },
      {
        name: "agent",
        content: {
          text: "I've identified the person in the blue shirt as Alice. I'll remember them for future interactions.",
          actions: ["NAME_ENTITY"],
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Call the person on the left Bob",
        },
      },
      {
        name: "agent",
        content: {
          text: "I've named the person on the left as Bob. Their face profile has been updated.",
          actions: ["NAME_ENTITY"],
        },
      },
    ],
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> =>
    hasVisionContextOrIntent(
      runtime,
      message,
      state,
      ["media", "memory"],
      [
        "name",
        "named",
        "call",
        "person",
        "entity",
        "remember",
        "object",
        "nombre",
        "llama",
        "persona",
        "nom",
        "appelle",
        "personne",
        "name",
        "nenne",
        "person",
        "nome",
        "chiama",
        "persona",
        "名前",
        "呼ぶ",
        "人",
        "命名",
        "叫",
        "人",
        "이름",
        "불러",
        "사람",
      ],
    ),

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const visionService = runtime.getService<VisionService>("VISION");

      if (!visionService) {
        const thought = "Vision service is not available.";
        const text =
          "I cannot name entities because the vision service is not available.";
        await saveExecutionRecord(runtime, message, thought, text, [
          "NAME_ENTITY",
        ]);
        if (callback) {
          await callback({ thought, text, actions: ["NAME_ENTITY"] });
        }
        return {
          success: false,
          text,
        };
      }

      const maxVisionEntities = MAX_VISION_ENTITIES;
      const scene = await withVisionTimeout(
        visionService.getSceneDescription(),
        "vision scene description",
      );

      if (!scene || scene.people.length === 0) {
        const thought = "No people visible to name.";
        const text = "I don't see any people in the current scene to name.";
        await saveExecutionRecord(runtime, message, thought, text, [
          "NAME_ENTITY",
        ]);
        if (callback) {
          await callback({ thought, text, actions: ["NAME_ENTITY"] });
        }
        return {
          success: false,
          text,
        };
      }

      const params = readActionParams(_options);
      const text = message.content.text?.toLowerCase() || "";
      const explicitName =
        typeof params.name === "string" ? params.name.trim() : "";
      const nameMatch = explicitName
        ? [explicitName, explicitName]
        : text.match(/(?:named?|call(?:ed)?|is)\s+(\w+)/i);

      if (!nameMatch) {
        const thought = "Could not extract name from message.";
        const text =
          'I couldn\'t understand what name to assign. Please say something like "The person is named Alice".';
        await saveExecutionRecord(runtime, message, thought, text, [
          "NAME_ENTITY",
        ]);
        if (callback) {
          await callback({ thought, text, actions: ["NAME_ENTITY"] });
        }
        return {
          success: false,
          text,
        };
      }

      const name = nameMatch[1];
      const _worldId = message.worldId || "default-world";
      const entityTracker = visionService.getEntityTracker();

      // Update entities
      await entityTracker.updateEntities(
        scene.objects.slice(0, maxVisionEntities),
        scene.people.slice(0, maxVisionEntities),
        undefined,
        runtime,
      );
      const activeEntities = entityTracker.getActiveEntities();
      const people = activeEntities.filter((e) => e.entityType === "person");

      if (people.length === 0) {
        const thought = "No tracked people found.";
        const text =
          "I can see someone but haven't established tracking yet. Please try again in a moment.";
        await saveExecutionRecord(runtime, message, thought, text, [
          "NAME_ENTITY",
        ]);
        if (callback) {
          await callback({ thought, text, actions: ["NAME_ENTITY"] });
        }
        return {
          success: false,
          text,
        };
      }

      // For now, assign to the most prominent person (largest bounding box)
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
          ["NAME_ENTITY"],
          undefined,
        );

        if (callback) {
          await callback({
            thought,
            text,
            actions: ["NAME_ENTITY"],
            data: { entityId: targetPerson.id, name },
          });
        }

        logger.info(
          `[NameEntityAction] Assigned name "${name}" to entity ${targetPerson.id}`,
        );
        return {
          success: true,
          text,
          values: {
            entityId: targetPerson.id,
            name,
          },
        };
      } else {
        const thought = "Failed to assign name to entity.";
        const text = "There was an error assigning the name. Please try again.";
        await saveExecutionRecord(runtime, message, thought, text, [
          "NAME_ENTITY",
        ]);
        if (callback) {
          await callback({ thought, text, actions: ["NAME_ENTITY"] });
        }
        return {
          success: false,
          text,
        };
      }
    } catch (error) {
      logger.error("[NameEntityAction] Error:", error);
      const thought = "Failed to name entity.";
      const text = `Sorry, I couldn't name the entity: ${error instanceof Error ? error.message : "Unknown error"}`;
      await saveExecutionRecord(runtime, message, thought, text, [
        "NAME_ENTITY",
      ]);
      if (callback) {
        await callback({ thought, text, actions: ["NAME_ENTITY"] });
      }
      return {
        success: false,
        text,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

export const identifyPersonAction: Action = {
  name: "IDENTIFY_PERSON",
  contexts: ["media", "memory"],
  contextGate: { anyOf: ["media", "memory"] },
  roleGate: { minRole: "USER" },
  description: "Identify a person in view if they have been seen before",
  descriptionCompressed: "Match face to known person via local recognition.",
  similes: [
    "who is that",
    "who is the person",
    "identify the person",
    "do you recognize them",
    "have you seen them before",
  ],
  parameters: [
    {
      name: "targetHint",
      description: "Optional description of the visible person to focus on.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "includeUnknown",
      description: "Whether to mention unidentified people in the response.",
      required: false,
      schema: { type: "boolean", default: true },
    },
  ],
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Who is the person in front of you?",
        },
      },
      {
        name: "agent",
        content: {
          text: "That's Alice. I last saw her about 5 minutes ago. She's been here for the past 20 minutes.",
          actions: ["IDENTIFY_PERSON"],
        },
      },
    ],
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> =>
    hasVisionContextOrIntent(
      runtime,
      message,
      state,
      ["media", "memory"],
      [
        "identify",
        "recognize",
        "who is",
        "person",
        "face",
        "seen before",
        "identificar",
        "reconoces",
        "persona",
        "visage",
        "reconnais",
        "personne",
        "erkennen",
        "gesicht",
        "person",
        "riconosci",
        "persona",
        "識別",
        "誰",
        "顔",
        "识别",
        "是谁",
        "人",
        "식별",
        "누구",
        "얼굴",
      ],
    ),

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const visionService = runtime.getService<VisionService>("VISION");

      if (!visionService) {
        const thought = "Vision service is not available.";
        const text =
          "I cannot identify people because the vision service is not available.";
        await saveExecutionRecord(runtime, message, thought, text, [
          "IDENTIFY_PERSON",
        ]);
        if (callback) {
          await callback({ thought, text, actions: ["IDENTIFY_PERSON"] });
        }
        return {
          success: false,
          text,
        };
      }

      const maxVisionEntities = MAX_VISION_ENTITIES;
      const scene = await withVisionTimeout(
        visionService.getSceneDescription(),
        "vision scene description",
      );

      if (!scene || scene.people.length === 0) {
        const thought = "No people visible to identify.";
        const text = "I don't see any people in the current scene.";
        await saveExecutionRecord(runtime, message, thought, text, [
          "IDENTIFY_PERSON",
        ]);
        if (callback) {
          await callback({ thought, text, actions: ["IDENTIFY_PERSON"] });
        }
        return {
          success: false,
          text,
        };
      }

      // Get entity tracker
      const _worldId = message.worldId || "default-world";
      const entityTracker = visionService.getEntityTracker();

      // Update entities
      await entityTracker.updateEntities(
        scene.objects.slice(0, maxVisionEntities),
        scene.people.slice(0, maxVisionEntities),
        undefined,
        runtime,
      );
      const activeEntities = entityTracker.getActiveEntities();
      const people = activeEntities.filter((e) => e.entityType === "person");

      if (people.length === 0) {
        const thought = "No tracked people found.";
        const text =
          "I can see someone but I'm still processing their identity.";
        await saveExecutionRecord(runtime, message, thought, text, [
          "IDENTIFY_PERSON",
        ]);
        if (callback) {
          await callback({ thought, text, actions: ["IDENTIFY_PERSON"] });
        }
        return {
          success: false,
          text,
        };
      }

      const _responseText = "";
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

          // Add more context if available
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

      await saveExecutionRecord(runtime, message, thought, text, [
        "IDENTIFY_PERSON",
      ]);

      if (callback) {
        await callback({
          thought,
          text,
          actions: ["IDENTIFY_PERSON"],
          data: {
            identifications: people.slice(0, maxVisionEntities).map((p) => ({
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
        values: {
          recognizedCount,
          unknownCount,
        },
      };
    } catch (error) {
      logger.error("[identifyPersonAction] Error:", error);
      const thought = "Failed to identify people.";
      const text = `Sorry, I couldn't identify people: ${error instanceof Error ? error.message : "Unknown error"}`;
      await saveExecutionRecord(runtime, message, thought, text, [
        "IDENTIFY_PERSON",
      ]);
      if (callback) {
        await callback({ thought, text, actions: ["IDENTIFY_PERSON"] });
      }
      return {
        success: false,
        text,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

export const trackEntityAction: Action = {
  name: "TRACK_ENTITY",
  contexts: ["media", "screen_time", "automation"],
  contextGate: { anyOf: ["media", "screen_time", "automation"] },
  roleGate: { minRole: "USER" },
  description: "Start tracking a specific person or object in view",
  descriptionCompressed: "Track entity id across frames.",
  similes: [
    "track the {description}",
    "follow the {description}",
    "keep an eye on the {description}",
    "watch the {description}",
  ],
  parameters: [
    {
      name: "description",
      description:
        "Optional description of the visible entity to prioritize for tracking.",
      required: false,
      schema: { type: "string" },
    },
  ],
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Track the person wearing the red shirt",
        },
      },
      {
        name: "agent",
        content: {
          text: "I'm now tracking the person in the red shirt. I'll notify you of any significant movements or if they leave the scene.",
          actions: ["TRACK_ENTITY"],
        },
      },
    ],
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> =>
    hasVisionContextOrIntent(
      runtime,
      message,
      state,
      ["media", "screen_time", "automation"],
      [
        "track",
        "follow",
        "watch",
        "keep an eye",
        "entity",
        "person",
        "object",
        "rastrear",
        "seguir",
        "vigilar",
        "persona",
        "suivre",
        "surveiller",
        "personne",
        "verfolgen",
        "beobachten",
        "person",
        "traccia",
        "segui",
        "persona",
        "追跡",
        "見張",
        "人",
        "跟踪",
        "关注",
        "人",
        "추적",
        "지켜봐",
        "사람",
      ],
    ),

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const visionService = runtime.getService<VisionService>("VISION");

      if (!visionService) {
        const thought = "Vision service is not available.";
        const text =
          "I cannot track entities because the vision service is not available.";
        await saveExecutionRecord(runtime, message, thought, text, [
          "TRACK_ENTITY",
        ]);
        if (callback) {
          await callback({ thought, text, actions: ["TRACK_ENTITY"] });
        }
        return {
          success: false,
          text,
        };
      }

      const maxVisionEntities = MAX_VISION_ENTITIES;
      const scene = await withVisionTimeout(
        visionService.getSceneDescription(),
        "vision scene description",
      );

      if (!scene) {
        const thought = "No scene available for tracking.";
        const text =
          "I need a moment to process the visual scene before I can track entities.";
        await saveExecutionRecord(runtime, message, thought, text, [
          "TRACK_ENTITY",
        ]);
        if (callback) {
          await callback({ thought, text, actions: ["TRACK_ENTITY"] });
        }
        return {
          success: false,
          text,
        };
      }

      const _text = message.content.text?.toLowerCase() || "";
      const _worldId = message.worldId || "default-world";
      const entityTracker = visionService.getEntityTracker();
      await entityTracker.updateEntities(
        scene.objects.slice(0, maxVisionEntities),
        scene.people.slice(0, maxVisionEntities),
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
        "TRACK_ENTITY",
      ]);

      if (callback) {
        await callback({
          thought,
          text: responseText,
          actions: ["TRACK_ENTITY"],
          data: { entities: stats.activeEntities },
        });
      }

      logger.info(
        `[TrackEntityAction] Tracking ${stats.activeEntities} entities`,
      );
      return {
        success: true,
        text: responseText,
        values: {
          activeEntities: stats.activeEntities,
          people: stats.people,
          objects: stats.objects,
        },
      };
    } catch (error) {
      logger.error("[trackEntityAction] Error:", error);
      const thought = "Failed to track entities.";
      const text = `Sorry, I couldn't track entities: ${error instanceof Error ? error.message : "Unknown error"}`;
      await saveExecutionRecord(runtime, message, thought, text, [
        "TRACK_ENTITY",
      ]);
      if (callback) {
        await callback({ thought, text, actions: ["TRACK_ENTITY"] });
      }
      return {
        success: false,
        text,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
