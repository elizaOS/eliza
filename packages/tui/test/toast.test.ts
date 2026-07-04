/**
 * Toast component tests verify compact notification rendering with wide
 * characters, ANSI styling, and borders.
 */

import { describe, expect, test } from "vitest";
import { Toast } from "../src/components/toast.js";
import { visibleWidth } from "../src/utils.js";

describe("Toast", () => {
  test("does not exceed width when truncating wide characters", () => {
    const lines = new Toast("你好你好", {
      showIcon: false,
      showBorder: false,
      paddingX: 0,
    }).render(3);

    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(3);
  });

  test("does not count ANSI styling toward message width", () => {
    const lines = new Toast("\x1b[31mabcdef\x1b[0m", {
      showIcon: false,
      showBorder: false,
      paddingX: 0,
    }).render(4);

    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(4);
  });
});
