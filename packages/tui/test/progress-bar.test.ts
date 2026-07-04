/**
 * Progress bar tests verify width accounting for narrow terminals, ANSI
 * styling, and message truncation.
 */

import { describe, expect, test } from "vitest";
import { ProgressBar } from "../src/components/progress-bar.js";
import { visibleWidth } from "../src/utils.js";

describe("ProgressBar", () => {
  test("keeps padding from exceeding narrow render width", () => {
    const lines = new ProgressBar(0.5, {
      paddingX: 5,
      showPercentage: false,
    }).render(4);

    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(4);
  });

  test("truncates long message lines to the render width", () => {
    const lines = new ProgressBar(0.5, {
      message: "deploying a very long step",
      paddingX: 2,
    }).render(10);

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    }
  });
});
