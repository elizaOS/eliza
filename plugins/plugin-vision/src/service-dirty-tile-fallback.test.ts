/**
 * Camera-loop scene update when the per-tile describe fails.
 *
 * Once a scene exists, `updateSceneDescription` prefers the change-gated
 * per-tile describer (built from plugin-computeruse's `frameDhash`) and falls
 * back to the full-frame describe when that path has no usable result. A
 * failing IMAGE_DESCRIPTION call inside the per-tile path must take the same
 * fallback, so the frame's detections, timestamp and entity tracking are still
 * recorded while the model is down.
 *
 * Driven through a real SQLite-backed AgentRuntime and the service's own
 * camera loop (`captureAndProcessFrame`); only the camera device is replaced,
 * because it is hardware. The optional plugin-computeruse peer resolves to its
 * built `dist`, so the specifier is pointed at the real `frameDhash` source.
 */

import { ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VisionService } from "./service";
import type { SceneDescription } from "./types";

vi.mock("@elizaos/plugin-computeruse", async () => ({
  frameDhash: (await import("../../plugin-computeruse/src/scene/dhash"))
    .frameDhash,
}));

type Runtime = ReturnType<typeof createSQLiteTestRuntime>;
const runtimes: Runtime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.close();
  }
});

interface CameraLoop {
  camera: { id: string; name: string; capture: () => Promise<Buffer> } | null;
  captureAndProcessFrame(): Promise<void>;
  lastSceneDescription: SceneDescription | null;
}

function solidPng(shade: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r: shade, g: shade, b: shade },
    },
  })
    .png()
    .toBuffer();
}

describe("VisionService per-tile describe failure", () => {
  it("records the frame through the full-frame fallback when IMAGE_DESCRIPTION fails", async () => {
    const runtime = createSQLiteTestRuntime({
      character: { name: "VisionCamera", bio: [] },
    });
    runtimes.push(runtime);

    const calls: string[] = [];
    let modelDown = false;
    runtime.registerModel(
      ModelType.IMAGE_DESCRIPTION,
      async (_runtime, params) => {
        const imageUrl = (params as { imageUrl: string }).imageUrl;
        calls.push(imageUrl.slice(0, imageUrl.indexOf(";")));
        if (modelDown) {
          throw new Error("IMAGE_DESCRIPTION provider returned 503");
        }
        return { description: "A quiet desk" };
      },
      "test",
    );

    const service = new VisionService(runtime) as unknown as CameraLoop;
    let frame = await solidPng(10);
    service.camera = {
      id: "test-camera",
      name: "Test camera",
      capture: async () => frame,
    };

    await service.captureAndProcessFrame();
    const first = service.lastSceneDescription;
    expect(first?.description).toBe("A quiet desk");

    // The model goes down and the whole view changes.
    modelDown = true;
    calls.length = 0;
    frame = await solidPng(220);
    await service.captureAndProcessFrame();

    // The per-tile path ran first (PNG tile), then the full-frame path (JPEG).
    expect(calls).toEqual(["data:image/png", "data:image/jpeg"]);
    const second = service.lastSceneDescription;
    expect(second).not.toBe(first);
    expect(second?.description).not.toBe("A quiet desk");
    expect(second?.descriptionStale).toBe(false);
  });
});
