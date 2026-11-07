/**
 * Camera-loop face attribution.
 *
 * When face recognition is on, `updateSceneDescription` assigns each detected
 * face to the person whose box holds it, recognizes or registers the face and
 * hands the person-to-face map to the entity tracker. A face is a small box
 * inside the person box, so the match has to measure how much of the face the
 * person box covers, not the IoU of the two boxes.
 *
 * Driven through a real SQLite-backed AgentRuntime and the service's own
 * camera loop (`captureAndProcessFrame`); the person comes from the service's
 * motion detector. Only the camera device and the native face library (FFI
 * detector + embedder) are replaced, because they are hardware and a built
 * native binary.
 */

import { ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VisionService } from "./service";
import type { BoundingBox, SceneDescription } from "./types";

const native = vi.hoisted(() => ({
  faceBox: { x: 0, y: 0, width: 0, height: 0 },
  registered: [] as string[],
}));

vi.mock("./face-recognition-ggml", () => ({
  FaceRecognition: class {
    async initialize(): Promise<void> {}
    isInitialized(): boolean {
      return true;
    }
    async detectFaces() {
      return [
        {
          detection: { box: native.faceBox },
          descriptor: new Float32Array(128),
        },
      ];
    }
    async recognizeFace() {
      return null;
    }
    async addOrUpdateFace(): Promise<string> {
      const profileId = `face-${native.registered.length + 1}`;
      native.registered.push(profileId);
      return profileId;
    }
    getFaceProfile() {
      return undefined;
    }
    async dispose(): Promise<void> {}
  },
}));

type Runtime = ReturnType<typeof createSQLiteTestRuntime>;
const runtimes: Runtime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.close();
  }
  native.registered.length = 0;
});

interface CameraLoop {
  camera: { id: string; name: string; capture: () => Promise<Buffer> } | null;
  captureAndProcessFrame(): Promise<void>;
  lastSceneDescription: SceneDescription | null;
}

const WIDTH = 640;
const HEIGHT = 480;

function emptyRoom(): Promise<Buffer> {
  return sharp({
    create: {
      width: WIDTH,
      height: HEIGHT,
      channels: 3,
      background: { r: 20, g: 20, b: 20 },
    },
  })
    .png()
    .toBuffer();
}

async function personEnters(body: BoundingBox): Promise<Buffer> {
  const figure = await sharp({
    create: {
      width: body.width,
      height: body.height,
      channels: 3,
      background: { r: 220, g: 220, b: 220 },
    },
  })
    .png()
    .toBuffer();
  return sharp(await emptyRoom())
    .composite([{ input: figure, left: body.x, top: body.y }])
    .png()
    .toBuffer();
}

describe("VisionService face attribution", () => {
  it.each([
    [
      "full-body framing",
      { x: 192, y: 64, width: 192, height: 384 },
      { x: 250, y: 80, width: 80, height: 96 },
    ],
    [
      "close-up framing",
      { x: 160, y: 32, width: 256, height: 416 },
      { x: 208, y: 48, width: 160, height: 200 },
    ],
  ])(
    "attributes a face inside the person box to that person (%s)",
    async (_framing, body: BoundingBox, faceBox: BoundingBox) => {
      native.faceBox = faceBox;
      const runtime = createSQLiteTestRuntime({
        character: {
          name: "VisionCamera",
          bio: [],
          settings: { ENABLE_FACE_RECOGNITION: "true" },
        },
      });
      runtimes.push(runtime);
      runtime.registerModel(
        ModelType.IMAGE_DESCRIPTION,
        async () => ({ description: "A room" }),
        "test",
      );

      const service = new VisionService(runtime) as unknown as CameraLoop;
      let frame = await emptyRoom();
      service.camera = {
        id: "test-camera",
        name: "Test camera",
        capture: async () => frame,
      };

      await service.captureAndProcessFrame();
      frame = await personEnters(body);
      await service.captureAndProcessFrame();

      const people = service.lastSceneDescription?.people ?? [];
      expect(people).toHaveLength(1);
      const personBox = people[0].boundingBox;
      // The face lies wholly inside the person the motion detector found.
      expect(faceBox.x).toBeGreaterThanOrEqual(personBox.x);
      expect(faceBox.y).toBeGreaterThanOrEqual(personBox.y);
      expect(faceBox.x + faceBox.width).toBeLessThanOrEqual(
        personBox.x + personBox.width,
      );
      expect(faceBox.y + faceBox.height).toBeLessThanOrEqual(
        personBox.y + personBox.height,
      );

      expect(native.registered).toEqual(["face-1"]);
      const tracked = (service as unknown as VisionService)
        .getEntityTracker()
        .getActiveEntities()
        .filter((entity) => entity.entityType === "person");
      expect(tracked.map((entity) => entity.attributes.faceId)).toEqual([
        "face-1",
      ]);
    },
  );

  it("leaves a face outside every person box unattributed", async () => {
    native.faceBox = { x: 480, y: 80, width: 80, height: 96 };
    const runtime = createSQLiteTestRuntime({
      character: {
        name: "VisionCamera",
        bio: [],
        settings: { ENABLE_FACE_RECOGNITION: "true" },
      },
    });
    runtimes.push(runtime);
    runtime.registerModel(
      ModelType.IMAGE_DESCRIPTION,
      async () => ({ description: "A room" }),
      "test",
    );

    const service = new VisionService(runtime) as unknown as CameraLoop;
    let frame = await emptyRoom();
    service.camera = {
      id: "test-camera",
      name: "Test camera",
      capture: async () => frame,
    };

    await service.captureAndProcessFrame();
    frame = await personEnters({ x: 192, y: 64, width: 192, height: 384 });
    await service.captureAndProcessFrame();

    expect(service.lastSceneDescription?.people ?? []).toHaveLength(1);
    expect(native.registered).toEqual([]);
    const tracked = (service as unknown as VisionService)
      .getEntityTracker()
      .getActiveEntities()
      .filter((entity) => entity.entityType === "person");
    expect(tracked.map((entity) => entity.attributes.faceId)).toEqual([
      undefined,
    ]);
  });
});
