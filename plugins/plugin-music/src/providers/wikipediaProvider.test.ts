/**
 * Wikipedia provider tests for request-context preservation.
 *
 * They verify extraction receives the user request across languages without
 * English keyword purpose inference.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { wikipediaProvider } from "./wikipediaProvider";

function messageWithText(text: string): Memory {
  return {
    content: { text },
  } as Memory;
}

describe("wikipediaProvider", () => {
  it("passes user request context without English keyword purpose inference", async () => {
    const extractFromWikipedia = vi.fn().mockResolvedValue({
      artist: { name: "Radiohead" },
      interestingFacts: ["formed in Oxfordshire"],
    });
    const runtime = {
      getService: vi.fn().mockReturnValue({
        detectEntities: vi
          .fn()
          .mockResolvedValue([
            { type: "artist", name: "Radiohead", confidence: 0.9 },
          ]),
        extractFromWikipedia,
      }),
    } as unknown as IAgentRuntime;

    await wikipediaProvider.get(
      runtime,
      messageWithText("recommend artists related to Radiohead"),
      {} as State,
    );
    await wikipediaProvider.get(
      runtime,
      messageWithText("Radioheadに似た音楽を教えて"),
      {} as State,
    );

    expect(extractFromWikipedia).toHaveBeenNthCalledWith(
      1,
      "Radiohead",
      "artist",
      expect.objectContaining({
        purpose: "general_info",
        currentArtist: "Radiohead",
        requestContext: "recommend artists related to Radiohead",
      }),
    );
    expect(extractFromWikipedia).toHaveBeenNthCalledWith(
      2,
      "Radiohead",
      "artist",
      expect.objectContaining({
        purpose: "general_info",
        currentArtist: "Radiohead",
        requestContext: "Radioheadに似た音楽を教えて",
      }),
    );
  });
});
