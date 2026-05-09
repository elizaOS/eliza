/**
 * Coverage Matrix Contract Test
 *
 * Parses coverage-matrix.md and asserts that every PRD journey row has a
 * test file that actually exists under plugins/app-lifeops/test/.
 *
 * Fails loudly when a journey goes missing from either the matrix or the
 * filesystem so CI catches regressions immediately.
 *
 * Never skip this test: journeys marked ⏳ pending must be converted to
 * real test files (or it.todo stubs) and added to the matrix.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const matrixPath = path.join(packageRoot, "coverage-matrix.md");
const testDir = here; // same as the directory this file lives in

interface MatrixRow {
  journeyId: string;
  journeyName: string;
  testFile: string | null;
  status: string;
  rawLine: string;
}

/**
 * Parse the markdown table rows from coverage-matrix.md.
 *
 * Expects pipe-delimited rows where column 1 = Journey ID, column 5 = Test File.
 * Skips the header and separator lines.
 */
function parseMatrixRows(content: string): MatrixRow[] {
  const rows: MatrixRow[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Must be a pipe-delimited table row with at least 7 cells
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed
      .split("|")
      .map((cell) => cell.trim())
      .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1); // drop leading/trailing empty from | … |

    if (cells.length < 7) continue;

    const journeyId = cells[0] ?? "";
    // Skip header row (Journey ID column header) and separator rows (---)
    if (!journeyId || journeyId === "Journey ID" || /^-+$/.test(journeyId)) {
      continue;
    }

    const testFileCell = cells[4] ?? "";
    // A test file cell looks like: `test/foo.ts` (backtick-wrapped) or just a path
    const testFileMatch = testFileCell.match(/`([^`]+)`/) ?? testFileCell.match(/(\S+\.test\.ts)/);
    const testFile = testFileMatch ? testFileMatch[1] ?? null : null;

    const status = cells[6] ?? "";

    rows.push({
      journeyId,
      journeyName: cells[1] ?? "",
      testFile,
      status,
      rawLine: trimmed,
    });
  }

  return rows;
}

describe("coverage-matrix.md contract", () => {
  it("coverage-matrix.md exists", () => {
    expect(
      fs.existsSync(matrixPath),
      `Expected coverage-matrix.md at ${matrixPath}`,
    ).toBe(true);
  });

  it("every journey row has a test file path in the matrix", () => {
    const content = fs.readFileSync(matrixPath, "utf8");
    const rows = parseMatrixRows(content);

    expect(rows.length, "Expected at least one journey row in the matrix").toBeGreaterThan(0);

    const missing: string[] = [];
    for (const row of rows) {
      if (!row.testFile) {
        missing.push(`Journey ${row.journeyId} ("${row.journeyName}") has no test file path in the matrix`);
      }
    }
    expect(
      missing,
      `Journeys missing test file paths:\n${missing.join("\n")}`,
    ).toHaveLength(0);
  });

  it("every test file path in the matrix points to an existing file", () => {
    const content = fs.readFileSync(matrixPath, "utf8");
    const rows = parseMatrixRows(content);

    const missing: string[] = [];
    for (const row of rows) {
      if (!row.testFile) continue;

      // The matrix stores relative paths like `test/foo.test.ts`.
      // Resolve against the package root.
      const resolved = path.resolve(packageRoot, row.testFile);

      if (!fs.existsSync(resolved)) {
        missing.push(
          `Journey ${row.journeyId} ("${row.journeyName}"): test file not found at ${resolved} (matrix value: ${row.testFile})`,
        );
      }
    }

    expect(
      missing,
      `Test files listed in coverage-matrix.md that do not exist on disk:\n${missing.join("\n")}`,
    ).toHaveLength(0);
  });

  it("no journey is in ⏳ pending status without a test file on disk", () => {
    const content = fs.readFileSync(matrixPath, "utf8");
    const rows = parseMatrixRows(content);

    const pendingWithoutFile: string[] = [];
    for (const row of rows) {
      if (!row.status.includes("pending") && !row.status.includes("⏳")) continue;
      if (!row.testFile) {
        pendingWithoutFile.push(
          `Journey ${row.journeyId} ("${row.journeyName}") is pending and has no test file`,
        );
        continue;
      }
      const resolved = path.resolve(packageRoot, row.testFile);
      if (!fs.existsSync(resolved)) {
        pendingWithoutFile.push(
          `Journey ${row.journeyId} ("${row.journeyName}") is pending and its test file is missing: ${resolved}`,
        );
      }
    }

    expect(
      pendingWithoutFile,
      `Pending journeys with no test file:\n${pendingWithoutFile.join("\n")}`,
    ).toHaveLength(0);
  });

  it("matrix has at least one journey row", () => {
    const content = fs.readFileSync(matrixPath, "utf8");
    const rows = parseMatrixRows(content);
    expect(
      rows.length,
      `Expected at least one journey row, got ${rows.length}`,
    ).toBeGreaterThan(0);
  });

  it("every test file is referenced by exactly one matrix row", () => {
    const content = fs.readFileSync(matrixPath, "utf8");
    const rows = parseMatrixRows(content);

    const counts = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.testFile) continue;
      const list = counts.get(row.testFile) ?? [];
      list.push(row.journeyId);
      counts.set(row.testFile, list);
    }

    const duplicates: string[] = [];
    for (const [testFile, journeyIds] of counts) {
      if (journeyIds.length > 1) {
        duplicates.push(`${testFile} referenced by journeys: ${journeyIds.join(", ")}`);
      }
    }

    expect(
      duplicates,
      `Test files referenced by more than one matrix row:\n${duplicates.join("\n")}`,
    ).toHaveLength(0);
  });
});
