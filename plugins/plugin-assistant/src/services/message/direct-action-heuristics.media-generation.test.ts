import { describe, expect, it } from "vitest";
import { looksLikeMediaGenerationRequest } from "./direct-action-heuristics.ts";
import { inferDirectCurrentRequestCandidateInference } from "./stage1-reply-policy.ts";

describe("media-generation direct candidate", () => {
  it.each([
    "damn i didnt even see the watermark, can you try to remake the image without it",
    "can you try urself with image gen?",
    "regenerate that picture without the text",
    "redo the logo in blue",
    "re-render the wallpaper at 4k",
    "remake the video without the watermark",
    "generate a short clip of a cat",
    "can you make a song about frogs",
    "generate an image based on this description",
    "create a logo called nubs",
    "make me a picture plz",
  ])("treats a media generation ask as an ask: %s", (text) => {
    expect(looksLikeMediaGenerationRequest(text)).toBe(true);
  });

  it.each([
    "recreate the docker image",
    "can you regenerate the docker image tag",
    "remake the image upload endpoint so it streams",
    "make the profile picture field optional",
    "create an image bucket on r2",
    "ok, run the image generator benchmark tomorrow",
    "don't use image gen, just describe it",
    "try image gen if you're bored, i'm going to bed",
    "did you try image gen?",
  ])(
    "keeps technical, negated, conditional and question text out: %s",
    (text) => {
      expect(looksLikeMediaGenerationRequest(text)).toBe(false);
    },
  );

  it("resolves the registered media action as the direct candidate", () => {
    expect(
      inferDirectCurrentRequestCandidateInference(
        [{ name: "REPLY" }, { name: "GENERATE_MEDIA" }],
        "can you try urself with image gen?",
      ),
    ).toEqual({ names: ["GENERATE_MEDIA"], kind: "media-generation" });
  });
});
