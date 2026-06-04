import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VisionPipeline } from "../services/vision-pipeline.ts";

function makeRuntime(result = "a desk with a laptop"): IAgentRuntime {
  return {
    useModel: vi.fn().mockResolvedValue(result),
  } as unknown as IAgentRuntime;
}

const FRAME_HEADER = {
  type: "frame" as const,
  ts: Date.now(),
  width: 1280,
  height: 720,
  format: "jpeg" as const,
};

describe("VisionPipeline", () => {
  let pipeline: VisionPipeline;

  beforeEach(() => {
    pipeline = new VisionPipeline();
  });

  it("stores and retrieves the latest frame", () => {
    const data = Buffer.alloc(512, 0xff);
    pipeline.storeFrame("conn1", FRAME_HEADER, data);
    const frame = pipeline.getLatestFrame("conn1");
    expect(frame).toBeDefined();
    expect(frame?.data).toBe(data);
  });

  it("returns undefined for an unknown connection", () => {
    expect(pipeline.getLatestFrame("unknown")).toBeUndefined();
  });

  it("clears frames on clear()", () => {
    pipeline.storeFrame("conn1", FRAME_HEADER, Buffer.alloc(128));
    pipeline.clear("conn1");
    expect(pipeline.getLatestFrame("conn1")).toBeUndefined();
  });

  it("describeFrame calls IMAGE_DESCRIPTION model with data URL", async () => {
    const runtime = makeRuntime("a red chair");
    const data = Buffer.from([0xff, 0xd8, 0xff]); // Minimal JPEG header bytes.
    pipeline.storeFrame("conn1", FRAME_HEADER, data);

    const result = await pipeline.describeFrame(runtime, "conn1");

    expect(runtime.useModel).toHaveBeenCalledWith(
      ModelType.IMAGE_DESCRIPTION,
      expect.objectContaining({
        imageUrl: expect.stringContaining("data:image/jpeg;base64,"),
      }),
    );
    expect(result).toBe("a red chair");
  });

  it("describeFrame returns null when no frame exists", async () => {
    const runtime = makeRuntime();
    const result = await pipeline.describeFrame(runtime, "conn1");
    expect(result).toBeNull();
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("hasRecentFrame returns true when frame exists", () => {
    pipeline.storeFrame("conn1", FRAME_HEADER, Buffer.alloc(64));
    expect(pipeline.hasRecentFrame("conn1")).toBe(true);
    expect(pipeline.hasRecentFrame("conn2")).toBe(false);
  });
});
