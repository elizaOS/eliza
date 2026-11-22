/**
 * The open chat sheet's fitted height: content fit without a waiting draft,
 * draft fit with one, and the bounds every result keeps.
 */
import { describe, expect, it } from "vitest";
import {
  type ChatSheetFitInput,
  resolveChatSheetFitHeight,
  SHEET_FIT_HIGH,
  SHEET_FIT_LOW,
} from "../chat-panel-layout";

const viewport = 915;
const base: ChatSheetFitInput = {
  viewport,
  low: Math.round(SHEET_FIT_LOW * viewport),
  high: Math.round(SHEET_FIT_HIGH * viewport),
  full: 855,
  content: 420,
  floor: 180,
  draft: false,
  stageNeed: 0,
  stageMin: 120,
};

describe("resolveChatSheetFitHeight", () => {
  it("fits the content between the low and high shares", () => {
    expect(resolveChatSheetFitHeight(base)).toBe(420);
    expect(resolveChatSheetFitHeight({ ...base, content: 90 })).toBe(base.low);
    expect(resolveChatSheetFitHeight({ ...base, content: 900 })).toBe(base.high);
  });

  it("gives a waiting draft the stage it needs, down to the floor", () => {
    expect(resolveChatSheetFitHeight({ ...base, draft: true, stageNeed: 600 })).toBe(viewport - 600);
    // A very long draft scrolls in the stage; the sheet keeps its floor.
    expect(resolveChatSheetFitHeight({ ...base, draft: true, stageNeed: 900 })).toBe(base.floor);
  });

  it("keeps the stage minimum and never exceeds full", () => {
    expect(resolveChatSheetFitHeight({ ...base, content: 900, stageMin: 500 })).toBe(viewport - 500);
    expect(resolveChatSheetFitHeight({ ...base, high: 900, content: 900, stageMin: 0 })).toBe(base.full);
    expect(resolveChatSheetFitHeight({ ...base, floor: 1000 })).toBe(base.full);
  });

  it("stays within its bounds for every input", () => {
    for (const content of [0, 200, 400, 700, 1200])
      for (const stageNeed of [0, 300, 700, 1200])
        for (const floor of [0, 150, 400, 900])
          for (const draft of [false, true]) {
            const input = { ...base, content, stageNeed, floor, draft };
            const height = resolveChatSheetFitHeight(input);
            expect(height).toBeLessThanOrEqual(input.full);
            expect(height).toBeGreaterThanOrEqual(Math.min(floor, input.full));
            if (!draft && floor <= input.low && input.stageMin <= viewport - input.high) {
              expect(height).toBeGreaterThanOrEqual(input.low);
              expect(height).toBeLessThanOrEqual(input.high);
            }
          }
  });
});
