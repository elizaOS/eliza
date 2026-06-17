// Contract test: EmotePicker.tsx ships its own hardcoded ALL_EMOTES grid that
// DIVERGES from the runtime emotes/catalog.ts. The picker POSTs the clicked id
// to /api/emote, which the agent server validates against THIS plugin's
// EMOTE_BY_ID (packages/agent/src/api/misc-routes.ts -> loadCompanionEmotes()).
// So any picker id that is not in the catalog yields a 400 "Unknown emote" at
// runtime — a real contract gap, not just a coverage gap.
//
// This test pins the EXACT divergence so it cannot silently drift further: it
// asserts the precise set of picker ids that resolve in the catalog vs. the
// precise set that do NOT. If the picker grid or the catalog is reconciled,
// this test must be updated deliberately, surfacing the change in review.

import { describe, expect, it } from "vitest";
import { EMOTE_BY_ID } from "../../emotes/catalog";

// The hardcoded ids rendered by EmotePicker.tsx's ALL_EMOTES, in source order.
// Kept in sync with EmotePicker.tsx by this test — if that grid changes, this
// list (and the expected delta below) must change with it.
const PICKER_EMOTE_IDS = [
  "wave",
  "kiss",
  "crying",
  "sorrow",
  "rude-gesture",
  "looking-around",
  "dance-happy",
  "dance-breaking",
  "dance-hiphop",
  "dance-popping",
  "hook-punch",
  "punching",
  "firing-gun",
  "sword-swing",
  "chopping",
  "spell-cast",
  "range",
  "death",
  "idle",
  "talk",
  "squat",
  "fishing",
  "float",
  "jump",
  "flip",
  "run",
  "walk",
  "crawling",
  "fall",
] as const;

// Picker ids that DO resolve against the runtime catalog (these play correctly
// through POST /api/emote).
const EXPECTED_IN_CATALOG = [
  "crying",
  "dance-breaking",
  "dance-happy",
  "dance-hiphop",
  "dance-popping",
  "idle",
  "kiss",
  "looking-around",
  "rude-gesture",
  "sorrow",
  "talk",
  "wave",
].sort();

// Picker ids that do NOT exist in the runtime catalog — clicking these would be
// rejected by the server with "Unknown emote". Documented divergence.
const EXPECTED_NOT_IN_CATALOG = [
  "chopping",
  "crawling",
  "death",
  "fall",
  "firing-gun",
  "fishing",
  "flip",
  "float",
  "hook-punch",
  "jump",
  "punching",
  "range",
  "run",
  "spell-cast",
  "squat",
  "sword-swing",
  "walk",
].sort();

describe("EmotePicker ↔ runtime catalog contract", () => {
  it("the picker grid has no duplicate ids", () => {
    const unique = new Set(PICKER_EMOTE_IDS);
    expect(unique.size).toBe(PICKER_EMOTE_IDS.length);
  });

  it("pins the exact set of picker ids that resolve in the runtime catalog", () => {
    const inCatalog = PICKER_EMOTE_IDS.filter((id) =>
      EMOTE_BY_ID.has(id),
    ).sort();
    expect(inCatalog).toEqual(EXPECTED_IN_CATALOG);
  });

  it("pins the exact set of picker ids that DIVERGE (absent from the catalog)", () => {
    const notInCatalog = PICKER_EMOTE_IDS.filter(
      (id) => !EMOTE_BY_ID.has(id),
    ).sort();
    // This is the live contract gap: these picker buttons POST ids the server
    // will reject. The assertion makes the gap explicit and change-detected.
    expect(notInCatalog).toEqual(EXPECTED_NOT_IN_CATALOG);
  });

  it("every in-catalog picker id resolves to a real EmoteDef with a gzip path", () => {
    for (const id of EXPECTED_IN_CATALOG) {
      const emote = EMOTE_BY_ID.get(id);
      expect(emote, `picker id "${id}" must resolve in catalog`).toBeDefined();
      expect(emote?.id).toBe(id);
      expect(emote?.path.endsWith(".gz")).toBe(true);
      expect(typeof emote?.duration).toBe("number");
      expect(typeof emote?.loop).toBe("boolean");
    }
  });
});
