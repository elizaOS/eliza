/**
 * Analytics CSV export writes one record per line. A name that contains a
 * line break must stay inside one quoted cell. The writer quoted commas and
 * quotes, and left the line break raw, so the next line became a new record.
 */
import { expect, test } from "bun:test";
import { generateCSV } from "./export";

test("keeps a line break inside one analytics CSV cell", () => {
  const csv = generateCSV([{ name: "Ann\nSmith" }], [{ key: "name", label: "Name" }]);
  expect(csv).toBe('Name\n"Ann\nSmith"');
  expect(generateCSV([{ name: "Ann\rSmith" }], [{ key: "name", label: "Name" }])).toBe(
    'Name\n"Ann\rSmith"',
  );
  expect(generateCSV([{ name: "Ann, Smith" }], [{ key: "name", label: "Name" }])).toBe(
    'Name\n"Ann, Smith"',
  );
});
