/**
 * @fileoverview Tests for the W3-2 → W3-3 personality-bench bridge in
 * `scripts/personality-bench-bridge.mjs`.
 *
 * The bridge translates scenario-side `judgeKwargs` (with `styleKey` /
 * `traitKey` / `direction` / `variantKey` enums plus 0-indexed user-turn
 * positions) into the judge's documented `personalityExpect` shape
 * (`options.{style,trait,direction,mode}` plus 1-indexed assistant
 * `checkTurns`).
 *
 * P0-2 (LifeOps synthesis plan, 2026-05-11) wired six trait/style keys —
 * `limerick`, `shakespearean`, `second_person_only` (styles) and
 * `first_name_only`, `metric_units`, `prefers_short` (traits) — through this
 * bridge. Before P0-2 the W4-G check functions existed but the bridge
 * silently routed those keys to "unknown style/trait" NEEDS_REVIEW. This
 * suite locks the wiring so a future bridge edit can't regress it.
 */

import { describe, expect, it } from "vitest";
import {
  bridgePersonalityExpect,
  type PersonalityScenarioLike,
  STYLE_KEY_TO_STYLE,
  TRAIT_KEY_TO_OPTIONS,
} from "../../../../scripts/personality-bench-bridge.mjs";

type TestScenario = PersonalityScenarioLike;

function holdStyleScenario(styleKey: string): TestScenario {
  return {
    personalityExpect: {
      bucket: "hold_style",
      judgeKwargs: {
        styleKey,
        instructionTurnIndex: 0,
        probeTurnIndices: [1, 2],
      },
    },
  };
}

function noteTraitScenario(
  traitKey: string,
  extra: Record<string, unknown> = {},
): TestScenario {
  return {
    personalityExpect: {
      bucket: "note_trait_unrelated",
      judgeKwargs: {
        traitKey,
        traitMentionTurnIndex: 0,
        traitCheckTurnIndices: [1, 2],
        ...extra,
      },
    },
  };
}

describe("personality-bench bridge — W4-G style/trait wiring (P0-2)", () => {
  describe("STYLE_KEY_TO_STYLE entries", () => {
    it("maps `limerick` to the judge's `limerick` style", () => {
      expect(STYLE_KEY_TO_STYLE.limerick).toBe("limerick");
    });

    it("maps `shakespearean` to the judge's `shakespearean` style", () => {
      expect(STYLE_KEY_TO_STYLE.shakespearean).toBe("shakespearean");
    });

    it("maps `second_person_only` to the judge's `second_person_only` style", () => {
      expect(STYLE_KEY_TO_STYLE.second_person_only).toBe("second_person_only");
    });

    it("preserves pre-existing entries (regression guard)", () => {
      expect(STYLE_KEY_TO_STYLE.no_hedging).toBe("no-hedging");
      expect(STYLE_KEY_TO_STYLE.haiku).toBe("haiku");
      expect(STYLE_KEY_TO_STYLE.pirate).toBe("pirate");
      expect(STYLE_KEY_TO_STYLE.terse_one_sentence).toBe("terse");
      expect(STYLE_KEY_TO_STYLE.all_lowercase).toBe("all_lowercase");
    });
  });

  describe("TRAIT_KEY_TO_OPTIONS entries", () => {
    it("maps `first_name_only` to a `first_name_only` trait spec", () => {
      expect(TRAIT_KEY_TO_OPTIONS.first_name_only).toEqual({
        trait: "first_name_only",
      });
    });

    it("maps `metric_units` to a `metric_units` trait spec", () => {
      expect(TRAIT_KEY_TO_OPTIONS.metric_units).toEqual({
        trait: "metric_units",
      });
    });

    it("maps `prefers_short` to a `prefers_short` trait spec", () => {
      expect(TRAIT_KEY_TO_OPTIONS.prefers_short).toEqual({
        trait: "prefers_short",
      });
    });

    it("preserves pre-existing entries (regression guard)", () => {
      expect(TRAIT_KEY_TO_OPTIONS.no_emojis).toEqual({ trait: "no-emojis" });
      expect(TRAIT_KEY_TO_OPTIONS.no_buddy_friend).toEqual({
        trait: "no-buddy",
        forbiddenPhrases: ["buddy", "friend"],
      });
      expect(TRAIT_KEY_TO_OPTIONS.code_blocks_only).toEqual({
        trait: "wants-code-blocks",
      });
    });
  });

  describe("bridgePersonalityExpect — hold_style", () => {
    for (const styleKey of [
      "limerick",
      "shakespearean",
      "second_person_only",
    ]) {
      it(`resolves styleKey=${styleKey} to a non-undefined options.style`, () => {
        const bridged = bridgePersonalityExpect(holdStyleScenario(styleKey));
        expect(bridged.bucket).toBe("hold_style");
        expect(bridged.options.style).toBeDefined();
        expect(bridged.options.style).toBe(STYLE_KEY_TO_STYLE[styleKey]);
        // probeTurnIndices [1,2] (0-indexed user) → assistant turns 4 and 6
        // (1-indexed in the alternating trajectory).
        expect(bridged.checkTurns).toEqual([4, 6]);
      });
    }

    it("does NOT inject maxTokens for non-terse styles", () => {
      const bridged = bridgePersonalityExpect(holdStyleScenario("limerick"));
      expect(bridged.options.maxTokens).toBeUndefined();
    });
  });

  describe("bridgePersonalityExpect — note_trait_unrelated", () => {
    for (const traitKey of [
      "first_name_only",
      "metric_units",
      "prefers_short",
    ]) {
      it(`resolves traitKey=${traitKey} to a non-undefined options.trait`, () => {
        const bridged = bridgePersonalityExpect(noteTraitScenario(traitKey));
        expect(bridged.bucket).toBe("note_trait_unrelated");
        expect(bridged.options.trait).toBeDefined();
        expect(bridged.options.trait).toBe(traitKey);
        expect(bridged.checkTurns).toEqual([4, 6]);
      });
    }

    it("forwards an explicit lastName for first_name_only when provided", () => {
      const bridged = bridgePersonalityExpect(
        noteTraitScenario("first_name_only", { lastName: "Garcia" }),
      );
      expect(bridged.options.lastName).toBe("Garcia");
    });

    it("tolerates snake-case last_name from the scenario side", () => {
      const bridged = bridgePersonalityExpect(
        noteTraitScenario("first_name_only", { last_name: "Garcia" }),
      );
      expect(bridged.options.lastName).toBe("Garcia");
    });

    it("omits lastName when the scenario does not specify it", () => {
      const bridged = bridgePersonalityExpect(
        noteTraitScenario("first_name_only"),
      );
      expect(bridged.options.lastName).toBeUndefined();
    });
  });

  describe("bridgePersonalityExpect — unknown keys still NEEDS_REVIEW", () => {
    it("emits no options.style for an unknown styleKey", () => {
      const bridged = bridgePersonalityExpect(
        holdStyleScenario("totally_made_up_style"),
      );
      expect(bridged.options.style).toBeUndefined();
    });

    it("emits no options.trait for an unknown traitKey", () => {
      const bridged = bridgePersonalityExpect(
        noteTraitScenario("totally_made_up_trait"),
      );
      expect(bridged.options.trait).toBeUndefined();
    });
  });
});
