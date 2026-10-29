/**
 * Camera-loop VLM change threshold.
 *
 * The plugin settings expose `PIXEL_CHANGE_THRESHOLD` ("Change Threshold":
 * "Percentage of pixels that must change to trigger VLM update", in
 * registry-entry.json and the package.json agentConfig), and the bundled
 * visual-assistant character sets it to "30". Between the time-based VLM
 * updates, the camera loop re-describes the scene as soon as that share of
 * pixels has changed. `VLM_CHANGE_THRESHOLD` names the same gate and wins when
 * both are set.
 *
 * Driven through a real SQLite-backed AgentRuntime and the service's own
 * camera loop (`captureAndProcessFrame`); only the camera device is replaced.
 */

import { ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { VisionService } from "./service";

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
}

const WIDTH = 100;
const HEIGHT = 40;

function darkRoom(): Promise<Buffer> {
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

/** The dark room with its top `rows` rows lit: rows / HEIGHT of the pixels change. */
async function lightTopRows(rows: number): Promise<Buffer> {
  const band = await sharp({
    create: {
      width: WIDTH,
      height: rows,
      channels: 3,
      background: { r: 230, g: 230, b: 230 },
    },
  })
    .png()
    .toBuffer();
  return sharp(await darkRoom())
    .composite([{ input: band, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

/**
 * Describe the dark room once, then light `rows` rows well inside the VLM
 * update interval. Returns whether the change triggered another describe.
 */
async function redescribesAfterChange(
  settings: Record<string, string>,
  rows: number,
): Promise<boolean> {
  const runtime = createSQLiteTestRuntime({
    character: { name: "VisionCamera", bio: [], settings },
  });
  runtimes.push(runtime);
  let describes = 0;
  runtime.registerModel(
    ModelType.IMAGE_DESCRIPTION,
    async () => {
      describes += 1;
      return { description: `Scene ${describes}` };
    },
    "test",
  );

  const service = new VisionService(runtime) as unknown as CameraLoop;
  let frame = await darkRoom();
  service.camera = {
    id: "test-camera",
    name: "Test camera",
    capture: async () => frame,
  };

  await service.captureAndProcessFrame();
  expect(describes).toBe(1);

  frame = await lightTopRows(rows);
  await service.captureAndProcessFrame();
  return describes > 1;
}

describe("VisionService VLM change threshold", () => {
  it("re-describes a 35% change when PIXEL_CHANGE_THRESHOLD is 30", async () => {
    await expect(
      redescribesAfterChange({ PIXEL_CHANGE_THRESHOLD: "30" }, 14),
    ).resolves.toBe(true);
  });

  it("keeps the description for a 20% change when PIXEL_CHANGE_THRESHOLD is 30", async () => {
    await expect(
      redescribesAfterChange({ PIXEL_CHANGE_THRESHOLD: "30" }, 8),
    ).resolves.toBe(false);
  });

  it("lets VLM_CHANGE_THRESHOLD win over PIXEL_CHANGE_THRESHOLD", async () => {
    await expect(
      redescribesAfterChange(
        { VLM_CHANGE_THRESHOLD: "60", PIXEL_CHANGE_THRESHOLD: "30" },
        14,
      ),
    ).resolves.toBe(false);
  });
});
