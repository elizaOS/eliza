/**
 * The user export stores a missing last-active time as "". formatDate parsed
 * every string with Date and called toISOString, so that row threw and the
 * whole export failed.
 */
import { expect, test } from "bun:test";
import { formatDate, generateCSV } from "./export";

test("keeps a missing last-active export cell empty", () => {
  expect(formatDate("")).toBe("");
  expect(() => formatDate("not-a-date")).toThrow();
  expect(() => formatDate(new Date(Number.NaN))).toThrow();
  expect(formatDate("2026-08-13T00:00:00.000Z")).toBe("2026-08-13T00:00:00.000Z");
  expect(
    generateCSV(
      [{ lastActive: "" }],
      [{ key: "lastActive", label: "Last Active", format: formatDate }],
    ),
  ).toBe("Last Active\n");
});
