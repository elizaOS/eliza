/**
 * Unit tests for notification shade gesture policy: validates gesture constants and touch locator.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_RENDERED_ROWS,
  SHADE_SETTLE_MS,
  touchWithIdentifier,
} from "./notification-shade-gesture-policy.ts";

describe("notification-shade-gesture-policy", () => {
  it("exports row limit and settle duration constants", () => {
    expect(MAX_RENDERED_ROWS).toBe(100);
    expect(SHADE_SETTLE_MS).toBe(460);
  });

  it("finds touch with matching identifier in TouchList", () => {
    const touch1 = {
      identifier: 1,
      clientX: 10,
      clientY: 20,
    } as unknown as Touch;
    const touch2 = {
      identifier: 2,
      clientX: 30,
      clientY: 40,
    } as unknown as Touch;
    const touchList = {
      0: touch1,
      1: touch2,
      length: 2,
      item: (i: number) => (i === 0 ? touch1 : touch2),
    } as unknown as TouchList;

    expect(touchWithIdentifier(touchList, 2)).toBe(touch2);
    expect(touchWithIdentifier(touchList, 99)).toBeUndefined();
  });
});
