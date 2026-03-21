/**
 * Tests for emote action — verifies enum is populated from catalog.
 */

import { describe, expect, it } from "vitest";
import { AGENT_EMOTE_CATALOG } from "../emotes/catalog";
import { emoteAction } from "./emote";

describe("emoteAction", () => {
  it("has a parameter with enum populated from the emote catalog", () => {
    const emoteParam = emoteAction.parameters?.find((p) => p.name === "emote");
    expect(emoteParam).toBeDefined();
    expect(emoteParam?.schema).toBeDefined();

    const schema = emoteParam?.schema as { type: string; enum?: string[] };
    expect(schema.enum).toBeDefined();
    expect(schema.enum).toHaveLength(AGENT_EMOTE_CATALOG.length);
  });

  it("enum contains expected emote IDs", () => {
    const emoteParam = emoteAction.parameters?.find((p) => p.name === "emote");
    const schema = emoteParam?.schema as { type: string; enum?: string[] };
    const ids = schema.enum ?? [];

    // Spot-check some known emotes
    expect(ids).toContain("dance-happy");
    expect(ids).toContain("wave");

    // Excluded emotes should not appear
    expect(ids).not.toContain("idle");
    expect(ids).not.toContain("run");
    expect(ids).not.toContain("walk");
  });

  it("includes common mappings in description", () => {
    const emoteParam = emoteAction.parameters?.find((p) => p.name === "emote");
    expect(emoteParam?.description).toContain("dance-happy");
    expect(emoteParam?.description).toContain("wave");
    expect(emoteParam?.description).toContain("fishing");
  });
});
