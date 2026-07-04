/**
 * Deterministic Wikipedia extraction tests for prompt context and cache-key
 * behavior using a stubbed text model.
 */
import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { WikipediaClient } from "./wikipediaClient";
import { WikipediaExtractionHelper } from "./wikipediaExtractionService";

describe("WikipediaExtractionHelper", () => {
  it("includes request context in prompts and cache keys", async () => {
    const prompts: string[] = [];
    const runtime = {
      useModel: vi.fn().mockImplementation((modelType, params) => {
        expect(modelType).toBe(ModelType.TEXT_LARGE);
        prompts.push(params.prompt);
        return '{"interestingFacts":["ok"]}';
      }),
    } as unknown as IAgentRuntime;
    const wikipediaClient = {
      getArtistInfo: vi.fn().mockResolvedValue({
        bio: "Radiohead are an English rock band.",
        genres: ["art rock"],
      }),
    } as unknown as WikipediaClient;
    const helper = new WikipediaExtractionHelper(runtime, wikipediaClient);

    await helper.extractFromWikipedia("Radiohead", "artist", {
      purpose: "general_info",
      currentArtist: "Radiohead",
      requestContext: "recommend artists related to Radiohead",
    });
    await helper.extractFromWikipedia("Radiohead", "artist", {
      purpose: "general_info",
      currentArtist: "Radiohead",
      requestContext: "Radioheadに似た音楽を教えて",
    });
    await helper.extractFromWikipedia("Radiohead", "artist", {
      purpose: "general_info",
      currentArtist: "Radiohead",
      requestContext: "  recommend   artists\nrelated to Radiohead  ",
    });

    expect(runtime.useModel).toHaveBeenCalledTimes(2);
    expect(prompts[0]).toContain(
      "User request: recommend artists related to Radiohead",
    );
    expect(prompts[1]).toContain("User request: Radioheadに似た音楽を教えて");
  });
});
