import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemeTrendService } from "./services";

describe("MemeTrendService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("refreshes meme templates from Imgflip and exposes prompt context", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              memes: [
                {
                  name: "Drake Hotline Bling",
                  url: "https://imgflip.test/drake.jpg",
                  width: 1200,
                  height: 1200,
                  box_count: 2,
                },
                {
                  name: "drake hotline bling",
                  url: "https://imgflip.test/duplicate.jpg",
                  box_count: 2,
                },
                {
                  name: "Two Buttons",
                  url: "https://imgflip.test/two-buttons.jpg",
                  box_count: 3,
                },
              ],
            },
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = await MemeTrendService.start({} as IAgentRuntime);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.imgflip.com/get_memes",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
      })
    );
    expect(service.getTrends(3)).toEqual([
      {
        name: "Drake Hotline Bling",
        url: "https://imgflip.test/drake.jpg",
        width: 1200,
        height: 1200,
        boxCount: 2,
      },
      {
        name: "Two Buttons",
        url: "https://imgflip.test/two-buttons.jpg",
        width: undefined,
        height: undefined,
        boxCount: 3,
      },
    ]);
    expect(service.getTrendContext()).toContain("Drake Hotline Bling, 2 text slots");

    await service.stop();
  });

  it("keeps fallback templates when refresh fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 503 })));

    const service = new MemeTrendService();
    await service.pollTrends();

    expect(service.getTrends(2).map((trend) => trend.name)).toEqual([
      "Distracted Boyfriend",
      "Drake Hotline Bling",
    ]);
    expect(service.getTrendContext(1)).toContain("fallback templates");
  });
});
