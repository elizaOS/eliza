/** `agents.list[0].templates` overrides the style preset's failure replies key by key. */
import { resolveStylePresetById } from "@elizaos/host/protocol";
import { expect, it } from "vitest";
import { buildCharacterFromConfig } from "../src/runtime/build-character-config.ts";

it("overlays an agent entry's failure replies on the preset's", () => {
  const templates = {
    insufficientCreditsReply: "Out of credits; the owner must top up.",
  };
  const character = buildCharacterFromConfig({
    ui: { presetId: "eliza" },
    agents: { list: [{ id: "main", templates }] },
  });
  expect(character.templates).toEqual({
    ...resolveStylePresetById("eliza", "en")?.templates,
    ...templates,
  });
});
