/** Export row order is a pure function of row content, independent of input order and locale. */
import { expect, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";

const { serializePortableAccountDeletionExport, stableRows } = await import(
  "./account-deletion-export"
);

const rows: Array<Record<string, unknown>> = [
  { name: "zeta", created_at: new Date("2026-10-01T00:00:00.000Z") },
  { name: "zeta", created_at: new Date("2026-10-02T00:00:00.000Z") },
  { name: "Ärger" },
  { name: "alpha" },
  { name: "Zebra" },
  { name: "Beta" },
];

test("rows sort by serialized code units regardless of input order", () => {
  const forward = stableRows(rows);
  const reversed = stableRows([...rows].reverse());
  expect(reversed).toEqual(forward);
  // Rows with created_at serialize first (`{"created_at"` < `{"name"`). Code-unit
  // order then puts upper case before lower case and "Ä" last, where a locale
  // comparison would interleave them.
  expect(forward.map((row) => (row as { name: string }).name)).toEqual([
    "zeta",
    "zeta",
    "Beta",
    "Zebra",
    "alpha",
    "Ärger",
  ]);
});

test("two serializations of the same collection are byte-identical", () => {
  const serialize = (input: typeof rows) =>
    serializePortableAccountDeletionExport({
      requestId: "50000000-0000-4000-8000-000000000001",
      userId: "20000000-0000-4000-8000-000000000001",
      organizationId: "10000000-0000-4000-8000-000000000001",
      generatedAt: new Date("2026-10-03T00:00:00.000Z"),
      tables: [{ table: "notes", rowCount: input.length, rows: stableRows(input) }],
    });
  expect(Buffer.from(serialize([...rows].reverse())).equals(Buffer.from(serialize(rows)))).toBe(
    true,
  );
});
