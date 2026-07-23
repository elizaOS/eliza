/**
 * Verifies optional calendar integrations never become required Vite inputs.
 */

import { describe, expect, test } from "bun:test";
import { calendarOptimizeDeps } from "./calendar-optimize-deps";

describe("calendarOptimizeDeps", () => {
  test("omits unresolved optional Jalali entries", () => {
    expect(
      calendarOptimizeDeps({
        reactDayPickerEntry: "/modules/react-day-picker/index.js",
        dateFnsEntry: "/modules/date-fns/index.js",
        dateFnsLocaleEntry: "/modules/date-fns/locale.js",
      }),
    ).toEqual(["react-day-picker", "date-fns", "date-fns/locale"]);
  });

  test("includes each integration only after its entry resolves", () => {
    expect(
      calendarOptimizeDeps({
        dateFnsJalaliEntry: "/modules/date-fns-jalali/index.js",
      }),
    ).toEqual(["date-fns-jalali"]);
    expect(
      calendarOptimizeDeps({
        dateFnsJalaliLocaleEntry: "/modules/date-fns-jalali/locale.js",
      }),
    ).toEqual(["date-fns-jalali/locale"]);
  });
});
