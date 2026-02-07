import { describe, expect, it, vi } from "vitest";

// Import directly from source modules to avoid triggering TF/sharp dependencies through index
import {
  captureImageAction,
  describeSceneAction,
  identifyPersonAction,
  killAutonomousAction,
  nameEntityAction,
  setVisionModeAction,
  trackEntityAction,
} from "./action";
import { defaultVisionConfig, VisionConfigSchema } from "./config";
import { EntityTracker } from "./entity-tracker";
import {
  APIError,
  CameraError,
  CircuitBreaker,
  ConfigurationError,
  ErrorRecoveryManager,
  ModelInitializationError,
  ProcessingError,
  ScreenCaptureError,
  VisionError,
  VisionErrorHandler,
} from "./errors";
import { visionProvider } from "./provider";
import type {
  BoundingBox,
  CameraInfo,
  DetectedObject,
  PersonInfo,
  SceneDescription,
  TrackedEntity,
  VisionConfig,
  VisionFrame,
} from "./types";
import { VisionMode, VisionServiceType } from "./types";

// ============================================================================
// Helpers
// ============================================================================

function mockRuntime(serviceReturn: unknown = null) {
  return {
    getService: vi.fn().mockReturnValue(serviceReturn),
    agentId: "test-agent-id",
    getSetting: vi.fn().mockReturnValue(undefined),
    createMemory: vi.fn().mockResolvedValue(undefined),
    getEntityById: vi.fn().mockResolvedValue(null),
    createEntity: vi.fn().mockResolvedValue(undefined),
    updateEntity: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function mockMessage(text = "test") {
  return {
    content: { text },
    roomId: "room-1",
    worldId: "world-1",
  } as any;
}

// ============================================================================
// 1. Action Metadata
// ============================================================================

describe("Action Metadata", () => {
  describe("describeSceneAction", () => {
    it("has correct name", () => {
      expect(describeSceneAction.name).toBe("DESCRIBE_SCENE");
    });

    it("has similes array", () => {
      expect(describeSceneAction.similes).toContain("ANALYZE_SCENE");
      expect(describeSceneAction.similes).toContain("WHAT_DO_YOU_SEE");
      expect(describeSceneAction.similes).toContain("VISION_CHECK");
      expect(describeSceneAction.similes).toContain("LOOK_AROUND");
    });

    it("has description", () => {
      expect(describeSceneAction.description).toContain("visual scene");
    });

    it("has examples", () => {
      expect(describeSceneAction.examples).toBeDefined();
      expect(describeSceneAction.examples!.length).toBeGreaterThan(0);
    });
  });

  describe("captureImageAction", () => {
    it("has correct name", () => {
      expect(captureImageAction.name).toBe("CAPTURE_IMAGE");
    });

    it("has similes array", () => {
      expect(captureImageAction.similes).toContain("TAKE_PHOTO");
      expect(captureImageAction.similes).toContain("SCREENSHOT");
      expect(captureImageAction.similes).toContain("CAPTURE_FRAME");
      expect(captureImageAction.similes).toContain("TAKE_PICTURE");
    });

    it("has description about capturing frames", () => {
      expect(captureImageAction.description).toContain("Captures");
    });
  });

  describe("killAutonomousAction", () => {
    it("has correct name", () => {
      expect(killAutonomousAction.name).toBe("KILL_AUTONOMOUS");
    });

    it("has similes", () => {
      expect(killAutonomousAction.similes).toContain("STOP_AUTONOMOUS");
      expect(killAutonomousAction.similes).toContain("HALT_AUTONOMOUS");
      expect(killAutonomousAction.similes).toContain("KILL_AUTO_LOOP");
    });

    it("has description about stopping autonomous loop", () => {
      expect(killAutonomousAction.description).toContain("autonomous");
    });
  });

  describe("setVisionModeAction", () => {
    it("has correct name", () => {
      expect(setVisionModeAction.name).toBe("SET_VISION_MODE");
    });

    it("has description about vision modes", () => {
      expect(setVisionModeAction.description).toContain("OFF");
      expect(setVisionModeAction.description).toContain("CAMERA");
      expect(setVisionModeAction.description).toContain("SCREEN");
      expect(setVisionModeAction.description).toContain("BOTH");
    });

    it("has similes about changing modes", () => {
      expect(setVisionModeAction.similes!.length).toBeGreaterThan(0);
    });
  });

  describe("nameEntityAction", () => {
    it("has correct name", () => {
      expect(nameEntityAction.name).toBe("NAME_ENTITY");
    });

    it("has description about naming", () => {
      expect(nameEntityAction.description).toContain("name");
    });

    it("has examples", () => {
      expect(nameEntityAction.examples).toBeDefined();
      expect(nameEntityAction.examples!.length).toBeGreaterThan(0);
    });
  });

  describe("identifyPersonAction", () => {
    it("has correct name", () => {
      expect(identifyPersonAction.name).toBe("IDENTIFY_PERSON");
    });

    it("has description about identifying", () => {
      expect(identifyPersonAction.description).toContain("Identify");
    });

    it("has similes", () => {
      expect(identifyPersonAction.similes).toContain("who is that");
      expect(identifyPersonAction.similes).toContain("identify the person");
    });
  });

  describe("trackEntityAction", () => {
    it("has correct name", () => {
      expect(trackEntityAction.name).toBe("TRACK_ENTITY");
    });

    it("has description about tracking", () => {
      expect(trackEntityAction.description).toContain("track");
    });

    it("has similes about following/watching", () => {
      expect(trackEntityAction.similes).toBeDefined();
      expect(trackEntityAction.similes!.length).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// 2. Action validate()
// ============================================================================

describe("Action validate()", () => {
  it("describeScene returns false when no vision service", async () => {
    const runtime = mockRuntime(null);
    const result = await describeSceneAction.validate(runtime, mockMessage());
    expect(result).toBe(false);
  });

  it("describeScene returns false when service not active", async () => {
    const runtime = mockRuntime({ isActive: () => false });
    const result = await describeSceneAction.validate(runtime, mockMessage());
    expect(result).toBe(false);
  });

  it("describeScene returns true when service is active", async () => {
    const runtime = mockRuntime({ isActive: () => true });
    const result = await describeSceneAction.validate(runtime, mockMessage());
    expect(result).toBe(true);
  });

  it("captureImage returns false when no vision service", async () => {
    const runtime = mockRuntime(null);
    const result = await captureImageAction.validate(runtime, mockMessage());
    expect(result).toBe(false);
  });

  it("captureImage returns true when service is active", async () => {
    const runtime = mockRuntime({ isActive: () => true });
    const result = await captureImageAction.validate(runtime, mockMessage());
    expect(result).toBe(true);
  });

  it("killAutonomous always returns true", async () => {
    const runtime = mockRuntime(null);
    const result = await killAutonomousAction.validate(runtime, mockMessage());
    expect(result).toBe(true);
  });

  it("setVisionMode returns false when no service", async () => {
    const runtime = mockRuntime(null);
    const result = await setVisionModeAction.validate(runtime, mockMessage());
    expect(result).toBe(false);
  });

  it("setVisionMode returns true when service exists (even if not active)", async () => {
    const runtime = mockRuntime({ isActive: () => false });
    const result = await setVisionModeAction.validate(runtime, mockMessage());
    expect(result).toBe(true);
  });

  it("nameEntity returns false when no service", async () => {
    const runtime = mockRuntime(null);
    const result = await nameEntityAction.validate(runtime, mockMessage());
    expect(result).toBe(false);
  });

  it("nameEntity returns false when service not active", async () => {
    const runtime = mockRuntime({ isActive: () => false });
    const result = await nameEntityAction.validate(runtime, mockMessage());
    expect(result).toBe(false);
  });

  it("nameEntity returns true when service is active", async () => {
    const runtime = mockRuntime({ isActive: () => true });
    const result = await nameEntityAction.validate(runtime, mockMessage());
    expect(result).toBe(true);
  });

  it("identifyPerson returns false when no service", async () => {
    const runtime = mockRuntime(null);
    const result = await identifyPersonAction.validate(runtime, mockMessage());
    expect(result).toBe(false);
  });

  it("identifyPerson returns true when active", async () => {
    const runtime = mockRuntime({ isActive: () => true });
    const result = await identifyPersonAction.validate(runtime, mockMessage());
    expect(result).toBe(true);
  });

  it("trackEntity returns false when no service", async () => {
    const runtime = mockRuntime(null);
    const result = await trackEntityAction.validate(runtime, mockMessage());
    expect(result).toBe(false);
  });

  it("trackEntity returns true when active", async () => {
    const runtime = mockRuntime({ isActive: () => true });
    const result = await trackEntityAction.validate(runtime, mockMessage());
    expect(result).toBe(true);
  });
});

// ============================================================================
// 3. Config
// ============================================================================

describe("Config", () => {
  describe("defaultVisionConfig", () => {
    it("has expected defaults", () => {
      expect(defaultVisionConfig.pixelChangeThreshold).toBe(50);
      expect(defaultVisionConfig.updateInterval).toBe(100);
      expect(defaultVisionConfig.enablePoseDetection).toBe(false);
      expect(defaultVisionConfig.enableObjectDetection).toBe(false);
      expect(defaultVisionConfig.tfUpdateInterval).toBe(1000);
      expect(defaultVisionConfig.vlmUpdateInterval).toBe(10000);
      expect(defaultVisionConfig.tfChangeThreshold).toBe(10);
      expect(defaultVisionConfig.vlmChangeThreshold).toBe(50);
      expect(defaultVisionConfig.visionMode).toBe("CAMERA");
      expect(defaultVisionConfig.screenCaptureInterval).toBe(2000);
      expect(defaultVisionConfig.tileSize).toBe(256);
      expect(defaultVisionConfig.tileProcessingOrder).toBe("priority");
      expect(defaultVisionConfig.ocrEnabled).toBe(true);
      expect(defaultVisionConfig.florence2Enabled).toBe(true);
    });
  });

  describe("VisionConfigSchema", () => {
    it("parses empty object with all defaults", () => {
      const result = VisionConfigSchema.parse({});
      expect(result.pixelChangeThreshold).toBe(50);
      expect(result.updateInterval).toBe(100);
      expect(result.enableCamera).toBe(true);
      expect(result.enableObjectDetection).toBe(false);
      expect(result.enablePoseDetection).toBe(false);
      expect(result.visionMode).toBe("CAMERA");
      expect(result.tileSize).toBe(256);
      expect(result.ocrEnabled).toBe(true);
      expect(result.florence2Enabled).toBe(true);
      expect(result.logLevel).toBe("info");
      expect(result.debugMode).toBe(false);
      expect(result.maxMemoryUsageMB).toBe(2000);
      expect(result.maxTrackedEntities).toBe(100);
      expect(result.entityTimeout).toBe(30000);
      expect(result.faceMatchThreshold).toBe(0.6);
    });

    it("accepts custom values", () => {
      const result = VisionConfigSchema.parse({
        pixelChangeThreshold: 75,
        updateInterval: 200,
        visionMode: "BOTH",
        tileSize: 512,
        ocrEnabled: false,
        debugMode: true,
        logLevel: "debug",
      });
      expect(result.pixelChangeThreshold).toBe(75);
      expect(result.updateInterval).toBe(200);
      expect(result.visionMode).toBe("BOTH");
      expect(result.tileSize).toBe(512);
      expect(result.ocrEnabled).toBe(false);
      expect(result.debugMode).toBe(true);
      expect(result.logLevel).toBe("debug");
    });

    it("rejects invalid visionMode", () => {
      expect(() =>
        VisionConfigSchema.parse({ visionMode: "INVALID" })
      ).toThrow();
    });

    it("rejects pixelChangeThreshold out of range", () => {
      expect(() =>
        VisionConfigSchema.parse({ pixelChangeThreshold: 150 })
      ).toThrow();
      expect(() =>
        VisionConfigSchema.parse({ pixelChangeThreshold: -1 })
      ).toThrow();
    });

    it("rejects tileSize out of range", () => {
      expect(() =>
        VisionConfigSchema.parse({ tileSize: 10 })
      ).toThrow();
      expect(() =>
        VisionConfigSchema.parse({ tileSize: 2048 })
      ).toThrow();
    });

    it("accepts valid tileProcessingOrder values", () => {
      for (const order of ["sequential", "priority", "random"] as const) {
        const result = VisionConfigSchema.parse({ tileProcessingOrder: order });
        expect(result.tileProcessingOrder).toBe(order);
      }
    });

    it("accepts optional florence2 provider values", () => {
      for (const provider of ["local", "azure", "huggingface", "replicate"] as const) {
        const result = VisionConfigSchema.parse({ florence2Provider: provider });
        expect(result.florence2Provider).toBe(provider);
      }
    });
  });
});

// ============================================================================
// 4. Types
// ============================================================================

describe("Types", () => {
  describe("VisionServiceType", () => {
    it("has VISION constant", () => {
      expect(VisionServiceType.VISION).toBe("VISION");
    });
  });

  describe("VisionMode enum", () => {
    it("has all expected modes", () => {
      expect(VisionMode.OFF).toBe("OFF");
      expect(VisionMode.CAMERA).toBe("CAMERA");
      expect(VisionMode.SCREEN).toBe("SCREEN");
      expect(VisionMode.BOTH).toBe("BOTH");
    });
  });

  describe("BoundingBox", () => {
    it("can construct with position and size", () => {
      const box: BoundingBox = { x: 10, y: 20, width: 100, height: 50 };
      expect(box.x).toBe(10);
      expect(box.y).toBe(20);
      expect(box.width).toBe(100);
      expect(box.height).toBe(50);
    });

    it("can compute center", () => {
      const box: BoundingBox = { x: 0, y: 0, width: 200, height: 100 };
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      expect(centerX).toBe(100);
      expect(centerY).toBe(50);
    });

    it("can compute area", () => {
      const box: BoundingBox = { x: 0, y: 0, width: 50, height: 40 };
      const area = box.width * box.height;
      expect(area).toBe(2000);
    });

    it("can compute aspect ratio", () => {
      const wideBox: BoundingBox = { x: 0, y: 0, width: 200, height: 100 };
      expect(wideBox.width / wideBox.height).toBe(2);

      const tallBox: BoundingBox = { x: 0, y: 0, width: 50, height: 150 };
      expect(tallBox.width / tallBox.height).toBeCloseTo(0.333, 2);
    });
  });

  describe("CameraInfo", () => {
    it("can construct with id, name, connected", () => {
      const cam: CameraInfo = { id: "cam-1", name: "FaceTime HD", connected: true };
      expect(cam.id).toBe("cam-1");
      expect(cam.name).toBe("FaceTime HD");
      expect(cam.connected).toBe(true);
    });
  });

  describe("DetectedObject", () => {
    it("can construct with all fields", () => {
      const obj: DetectedObject = {
        id: "obj-1",
        type: "chair",
        confidence: 0.95,
        boundingBox: { x: 10, y: 20, width: 80, height: 60 },
      };
      expect(obj.id).toBe("obj-1");
      expect(obj.type).toBe("chair");
      expect(obj.confidence).toBe(0.95);
      expect(obj.boundingBox.width).toBe(80);
    });
  });

  describe("PersonInfo", () => {
    it("can construct with pose and facing", () => {
      const person: PersonInfo = {
        id: "person-1",
        pose: "standing",
        facing: "camera",
        confidence: 0.88,
        boundingBox: { x: 50, y: 10, width: 60, height: 180 },
      };
      expect(person.pose).toBe("standing");
      expect(person.facing).toBe("camera");
      expect(person.confidence).toBe(0.88);
    });

    it("supports all pose values", () => {
      const poses: Array<PersonInfo["pose"]> = ["sitting", "standing", "lying", "unknown"];
      for (const pose of poses) {
        const p: PersonInfo = {
          id: "p1",
          pose,
          facing: "unknown",
          confidence: 0.5,
          boundingBox: { x: 0, y: 0, width: 1, height: 1 },
        };
        expect(p.pose).toBe(pose);
      }
    });

    it("supports all facing values", () => {
      const facings: Array<PersonInfo["facing"]> = ["camera", "away", "left", "right", "unknown"];
      for (const facing of facings) {
        const p: PersonInfo = {
          id: "p1",
          pose: "unknown",
          facing,
          confidence: 0.5,
          boundingBox: { x: 0, y: 0, width: 1, height: 1 },
        };
        expect(p.facing).toBe(facing);
      }
    });

    it("supports optional keypoints", () => {
      const person: PersonInfo = {
        id: "person-2",
        pose: "standing",
        facing: "camera",
        confidence: 0.9,
        boundingBox: { x: 0, y: 0, width: 100, height: 200 },
        keypoints: [
          { part: "nose", position: { x: 50, y: 20 }, score: 0.95 },
          { part: "leftEye", position: { x: 45, y: 18 }, score: 0.92 },
        ],
      };
      expect(person.keypoints).toHaveLength(2);
      expect(person.keypoints![0].part).toBe("nose");
    });
  });

  describe("SceneDescription", () => {
    it("can construct a full scene", () => {
      const scene: SceneDescription = {
        timestamp: Date.now(),
        description: "A room with two people",
        objects: [
          { id: "o1", type: "desk", confidence: 0.9, boundingBox: { x: 0, y: 0, width: 200, height: 100 } },
        ],
        people: [
          { id: "p1", pose: "sitting", facing: "camera", confidence: 0.85, boundingBox: { x: 50, y: 10, width: 60, height: 150 } },
        ],
        sceneChanged: true,
        changePercentage: 45.2,
        audioTranscription: "Hello there",
      };
      expect(scene.objects).toHaveLength(1);
      expect(scene.people).toHaveLength(1);
      expect(scene.sceneChanged).toBe(true);
      expect(scene.changePercentage).toBe(45.2);
      expect(scene.audioTranscription).toBe("Hello there");
    });
  });

  describe("VisionFrame", () => {
    it("can construct with buffer data", () => {
      const frame: VisionFrame = {
        timestamp: Date.now(),
        width: 640,
        height: 480,
        data: Buffer.alloc(640 * 480 * 4),
        format: "rgba",
      };
      expect(frame.width).toBe(640);
      expect(frame.height).toBe(480);
      expect(frame.format).toBe("rgba");
      expect(frame.data.length).toBe(640 * 480 * 4);
    });
  });
});

// ============================================================================
// 5. EntityTracker
// ============================================================================

describe("EntityTracker", () => {
  it("constructs with worldId", () => {
    const tracker = new EntityTracker("test-world");
    const state = tracker.getWorldState();
    expect(state.worldId).toBe("test-world");
    expect(state.entities.size).toBe(0);
    expect(state.activeEntities).toHaveLength(0);
  });

  it("tracks people from updateEntities", async () => {
    const tracker = new EntityTracker("world-1");
    const people: PersonInfo[] = [
      {
        id: "person-0-123",
        pose: "standing",
        facing: "camera",
        confidence: 0.9,
        boundingBox: { x: 100, y: 50, width: 60, height: 180 },
      },
    ];

    const result = await tracker.updateEntities([], people);
    expect(result).toHaveLength(1);
    expect(result[0].entityType).toBe("person");
    expect(result[0].firstSeen).toBeGreaterThan(0);
  });

  it("tracks objects from updateEntities", async () => {
    const tracker = new EntityTracker("world-1");
    const objects: DetectedObject[] = [
      {
        id: "obj-1",
        type: "chair",
        confidence: 0.8,
        boundingBox: { x: 200, y: 100, width: 50, height: 50 },
      },
    ];

    const result = await tracker.updateEntities(objects, []);
    expect(result).toHaveLength(1);
    expect(result[0].entityType).toBe("object");
    expect(result[0].attributes.objectType).toBe("chair");
  });

  it("does not double-count person objects", async () => {
    const tracker = new EntityTracker("world-1");
    const objects: DetectedObject[] = [
      { id: "obj-p", type: "person", confidence: 0.9, boundingBox: { x: 100, y: 50, width: 60, height: 180 } },
    ];
    const people: PersonInfo[] = [
      { id: "p1", pose: "standing", facing: "camera", confidence: 0.9, boundingBox: { x: 100, y: 50, width: 60, height: 180 } },
    ];

    const result = await tracker.updateEntities(objects, people);
    // Person objects are skipped in trackObject; only people array creates person entities
    expect(result).toHaveLength(1);
    expect(result[0].entityType).toBe("person");
  });

  it("returns active entities", async () => {
    const tracker = new EntityTracker("world-1");
    const people: PersonInfo[] = [
      { id: "p1", pose: "sitting", facing: "away", confidence: 0.7, boundingBox: { x: 0, y: 0, width: 50, height: 100 } },
    ];

    await tracker.updateEntities([], people);
    const active = tracker.getActiveEntities();
    expect(active).toHaveLength(1);
  });

  it("assignNameToEntity returns true for existing entity", async () => {
    const tracker = new EntityTracker("world-1");
    const people: PersonInfo[] = [
      { id: "p1", pose: "standing", facing: "camera", confidence: 0.9, boundingBox: { x: 100, y: 50, width: 60, height: 180 } },
    ];

    const result = await tracker.updateEntities([], people);
    const entityId = result[0].id;

    const success = tracker.assignNameToEntity(entityId, "Alice");
    expect(success).toBe(true);

    const entity = tracker.getEntity(entityId);
    expect(entity?.attributes.name).toBe("Alice");
  });

  it("assignNameToEntity returns false for non-existent entity", () => {
    const tracker = new EntityTracker("world-1");
    const success = tracker.assignNameToEntity("does-not-exist", "Bob");
    expect(success).toBe(false);
  });

  it("returns statistics", async () => {
    const tracker = new EntityTracker("world-1");
    const people: PersonInfo[] = [
      { id: "p1", pose: "standing", facing: "camera", confidence: 0.9, boundingBox: { x: 100, y: 50, width: 60, height: 180 } },
    ];
    const objects: DetectedObject[] = [
      { id: "o1", type: "chair", confidence: 0.8, boundingBox: { x: 300, y: 200, width: 50, height: 50 } },
    ];

    await tracker.updateEntities(objects, people);
    const stats = tracker.getStatistics();

    expect(stats.totalEntities).toBe(2);
    expect(stats.activeEntities).toBe(2);
    expect(stats.people).toBe(1);
    expect(stats.objects).toBe(1);
    expect(stats.recentlyLeft).toBe(0);
  });

  it("getRecentlyLeft returns empty initially", () => {
    const tracker = new EntityTracker("world-1");
    expect(tracker.getRecentlyLeft()).toHaveLength(0);
  });
});

// ============================================================================
// 6. Error Types
// ============================================================================

describe("Error Types", () => {
  describe("VisionError", () => {
    it("constructs with message and code", () => {
      const err = new VisionError("test error", "TEST_CODE", false);
      expect(err.message).toBe("test error");
      expect(err.code).toBe("TEST_CODE");
      expect(err.recoverable).toBe(false);
      expect(err.name).toBe("VisionError");
    });

    it("supports context", () => {
      const err = new VisionError("err", "CODE", true, { key: "value" });
      expect(err.recoverable).toBe(true);
      expect(err.context).toEqual({ key: "value" });
    });

    it("is an instance of Error", () => {
      const err = new VisionError("err", "CODE");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(VisionError);
    });
  });

  describe("CameraError", () => {
    it("has correct code and is recoverable", () => {
      const err = new CameraError("cam fail");
      expect(err.name).toBe("CameraError");
      expect(err.code).toBe("CAMERA_ERROR");
      expect(err.recoverable).toBe(true);
    });
  });

  describe("ScreenCaptureError", () => {
    it("has correct code and is recoverable", () => {
      const err = new ScreenCaptureError("screen fail");
      expect(err.name).toBe("ScreenCaptureError");
      expect(err.code).toBe("SCREEN_CAPTURE_ERROR");
      expect(err.recoverable).toBe(true);
    });
  });

  describe("ModelInitializationError", () => {
    it("has correct code and is not recoverable", () => {
      const err = new ModelInitializationError("init fail", "coco-ssd");
      expect(err.name).toBe("ModelInitializationError");
      expect(err.code).toBe("MODEL_INIT_ERROR");
      expect(err.recoverable).toBe(false);
      expect(err.context?.modelName).toBe("coco-ssd");
    });
  });

  describe("ProcessingError", () => {
    it("has correct code and is recoverable", () => {
      const err = new ProcessingError("proc fail");
      expect(err.name).toBe("ProcessingError");
      expect(err.code).toBe("PROCESSING_ERROR");
      expect(err.recoverable).toBe(true);
    });
  });

  describe("ConfigurationError", () => {
    it("has correct code and is not recoverable", () => {
      const err = new ConfigurationError("config bad");
      expect(err.name).toBe("ConfigurationError");
      expect(err.code).toBe("CONFIG_ERROR");
      expect(err.recoverable).toBe(false);
    });
  });

  describe("APIError", () => {
    it("has correct code with statusCode and endpoint", () => {
      const err = new APIError("api fail", 500, "/v1/analyze");
      expect(err.name).toBe("APIError");
      expect(err.code).toBe("API_ERROR");
      expect(err.statusCode).toBe(500);
      expect(err.endpoint).toBe("/v1/analyze");
      expect(err.recoverable).toBe(true);
    });
  });

  describe("CircuitBreaker", () => {
    it("starts in closed state", () => {
      const breaker = new CircuitBreaker(3, 1000, "test");
      expect(breaker.getState()).toBe("closed");
    });

    it("executes operation successfully", async () => {
      const breaker = new CircuitBreaker(3, 1000, "test");
      const result = await breaker.execute(async () => 42);
      expect(result).toBe(42);
      expect(breaker.getState()).toBe("closed");
    });

    it("can be reset", () => {
      const breaker = new CircuitBreaker(3, 1000, "test");
      breaker.reset();
      expect(breaker.getState()).toBe("closed");
    });
  });

  describe("VisionErrorHandler", () => {
    it("is a singleton", () => {
      const a = VisionErrorHandler.getInstance();
      const b = VisionErrorHandler.getInstance();
      expect(a).toBe(b);
    });

    it("can get a circuit breaker", () => {
      const handler = VisionErrorHandler.getInstance();
      const breaker = handler.getCircuitBreaker("test-breaker");
      expect(breaker).toBeDefined();
      expect(breaker.getState()).toBe("closed");
    });

    it("returns same breaker for same name", () => {
      const handler = VisionErrorHandler.getInstance();
      const a = handler.getCircuitBreaker("same");
      const b = handler.getCircuitBreaker("same");
      expect(a).toBe(b);
    });

    it("handles non-recoverable errors and returns false", async () => {
      const handler = VisionErrorHandler.getInstance();
      const err = new ConfigurationError("bad config");
      const recovered = await handler.handle(err);
      expect(recovered).toBe(false);
    });
  });
});

// ============================================================================
// 7. Provider Metadata
// ============================================================================

describe("Provider Metadata", () => {
  it("has correct name", () => {
    expect(visionProvider.name).toBe("VISION_PERCEPTION");
  });

  it("has a description", () => {
    expect(visionProvider.description).toContain("visual perception");
  });

  it("has position and dynamic fields", () => {
    expect(visionProvider.position).toBe(99);
    expect(visionProvider.dynamic).toBe(false);
  });

  it("has a get function", () => {
    expect(typeof visionProvider.get).toBe("function");
  });
});
