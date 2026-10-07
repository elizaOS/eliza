import { describe, expect, it } from "bun:test";
import { recordedFieldActivatedAt } from "./recorded-field-activated-at";

describe("recordedFieldActivatedAt", () => {
  it("keeps an activation recorded at epoch", () => {
    expect(recordedFieldActivatedAt(0, 1_700_000_000_000)).toBe(0);
  });

  it("uses now when the activation time was not recorded", () => {
    expect(recordedFieldActivatedAt(undefined, 1_700_000_000_000)).toBe(
      1_700_000_000_000,
    );
    expect(recordedFieldActivatedAt(Number.NaN, 1_700_000_000_000)).toBe(
      1_700_000_000_000,
    );
  });
});
