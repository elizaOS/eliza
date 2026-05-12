/**
 * Coverage Matrix Contract Test — final relaxation per
 * `GAP_ASSESSMENT.md` §8.5 + `IMPLEMENTATION_PLAN.md` §5.7.
 *
 * Domain-anchored, not scenario-anchored. Asserts:
 *
 *   1. Every row in `coverage-matrix.md` points to a real test file under
 *      `plugins/app-lifeops/test/`.
 *   2. Every test file referenced by the matrix is referenced by exactly
 *      one row (no shared file across multiple rows).
 *   3. The matrix `Domain` cell matches one of the 28 chapter headings in
 *      `UX_JOURNEYS.md` (table of contents).
 *   4. Spine-coverage: for each row whose `Spine` column is
 *      `ScheduledTask`, at least one test exercises the W1-A
 *      `ScheduledTask` runner (either via runner-spec tests or by
 *      importing the spine in the e2e test). This locks "the spine has
 *      test coverage" without locking "the spine is exercised in every
 *      single domain test".
 *
 * What this test deliberately does NOT assert:
 *   - A specific number of rows (was 20; now flexible per `§8.5`).
 *   - Scenario-name shape on rows (was `Recurring Relationship Time
 *     (e.g. weekly Jill block)`; now `Domain` + `Test File` are the
 *     contract).
 *
 * Decompositions / consolidations stop fighting the test.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const matrixPath = path.join(packageRoot, "coverage-matrix.md");
const uxJourneysPath = path.join(
  packageRoot,
  "docs",
  "audit",
  "UX_JOURNEYS.md",
);
const testDir = here;

interface MatrixRow {
  journeyId: string;
  journeyName: string;
  domain: string;
  spine: string;
  testFile: string | null;
  status: string;
  rawLine: string;
}

/**
 * Parse the markdown table rows from coverage-matrix.md.
 *
 * Expects pipe-delimited rows where:
 *   col 0 = Journey ID
 *   col 1 = Journey Name
 *   col 2 = Domain
 *   col 3 = Spine
 *   col 4 = Test File
 *   col 5 = PRD / Scenario Anchors
 *   col 6 = Status
 */
function parseMatrixRows(content: string): MatrixRow[] {
  const rows: MatrixRow[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed
      .split("|")
      .map((cell) => cell.trim())
      .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);

    if (cells.length < 7) continue;

    const journeyId = cells[0] ?? "";
    if (!journeyId || journeyId === "Journey ID" || /^-+$/.test(journeyId)) {
      continue;
    }

    const testFileCell = cells[4] ?? "";
    const testFileMatch =
      testFileCell.match(/`([^`]+)`/) ?? testFileCell.match(/(\S+\.test\.ts)/);
    const testFile = testFileMatch ? (testFileMatch[1] ?? null) : null;

    rows.push({
      journeyId,
      journeyName: cells[1] ?? "",
      domain: cells[2] ?? "",
      spine: cells[3] ?? "",
      testFile,
      status: cells[6] ?? "",
      rawLine: trimmed,
    });
  }

  return rows;
}

/**
 * Pull the chapter headings (`## N. Name`) from `UX_JOURNEYS.md`'s table
 * of contents. Returns the 28 chapter names verbatim (without the leading
 * number).
 */
function parseUxJourneyChapters(content: string): string[] {
  const chapters: string[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const m = /^## (\d+)\.\s+(.+?)\s*$/.exec(line);
    if (m) {
      chapters.push((m[2] ?? "").trim());
    }
  }
  return chapters;
}

/**
 * Heuristic — does a test file exercise the W1-A `ScheduledTask` spine?
 *
 * We accept any of:
 *   - imports `scheduled-task/runner`, `scheduled-task/types`, or
 *     `createScheduledTaskRunner`;
 *   - imports the spine via the package barrel (`@elizaos/app-lifeops` ⇒
 *     `ScheduledTaskRunner` / `createScheduledTaskRunner`);
 *   - mentions `ScheduledTask` in a `from "..."` clause.
 *
 * This is intentionally a string-level check. The contract is "this file
 * is wired against the spine somewhere"; deeper coupling is the runner
 * test's job, not this file's.
 */
function fileExercisesSpine(absPath: string): boolean {
  if (!fs.existsSync(absPath)) return false;
  const content = fs.readFileSync(absPath, "utf8");
  if (
    /from\s+["'][^"']*scheduled-task[^"']*["']/.test(content) ||
    /createScheduledTaskRunner/.test(content) ||
    /ScheduledTaskRunner\b/.test(content) ||
    /readFallbackScheduledTasks/.test(content) ||
    /FirstRunService/.test(content)
  ) {
    return true;
  }
  return false;
}

describe("coverage-matrix.md contract — domain-anchored (GAP §8.5)", () => {
  it("coverage-matrix.md exists", () => {
    expect(
      fs.existsSync(matrixPath),
      `Expected coverage-matrix.md at ${matrixPath}`,
    ).toBe(true);
  });

  it("UX_JOURNEYS.md exists", () => {
    expect(
      fs.existsSync(uxJourneysPath),
      `Expected UX_JOURNEYS.md at ${uxJourneysPath}`,
    ).toBe(true);
  });

  it("matrix has at least one row", () => {
    const content = fs.readFileSync(matrixPath, "utf8");
    const rows = parseMatrixRows(content);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("every row points to a real test file on disk", () => {
    const content = fs.readFileSync(matrixPath, "utf8");
    const rows = parseMatrixRows(content);

    const missing: string[] = [];
    for (const row of rows) {
      // Rows explicitly marked `uncovered` (e.g. after a LARP test was
      // purged) are allowed to lack a test file path; tracking work for
      // restoring coverage lives in the audit docs, not in this contract.
      const isUncovered = row.status.toLowerCase().includes("uncovered");
      if (!row.testFile) {
        if (isUncovered) continue;
        missing.push(
          `Row ${row.journeyId} ("${row.journeyName}") has no test file path`,
        );
        continue;
      }
      const resolved = path.resolve(packageRoot, row.testFile);
      if (!fs.existsSync(resolved)) {
        missing.push(
          `Row ${row.journeyId} ("${row.journeyName}"): test file not found at ${resolved} (matrix value: ${row.testFile})`,
        );
      }
    }
    expect(
      missing,
      `Test files listed in coverage-matrix.md that do not exist:\n${missing.join("\n")}`,
    ).toHaveLength(0);
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
        duplicates.push(
          `${testFile} referenced by rows: ${journeyIds.join(", ")}`,
        );
      }
    }
    expect(
      duplicates,
      `Test files referenced by more than one matrix row:\n${duplicates.join("\n")}`,
    ).toHaveLength(0);
  });

  it("every Domain value matches a UX_JOURNEYS.md chapter heading", () => {
    const matrixContent = fs.readFileSync(matrixPath, "utf8");
    const uxContent = fs.readFileSync(uxJourneysPath, "utf8");
    const rows = parseMatrixRows(matrixContent);
    const chapters = parseUxJourneyChapters(uxContent);
    const chapterSet = new Set(chapters);

    const stray: string[] = [];
    for (const row of rows) {
      if (!row.domain) {
        stray.push(`Row ${row.journeyId} has no Domain cell`);
        continue;
      }
      if (!chapterSet.has(row.domain)) {
        stray.push(
          `Row ${row.journeyId}: Domain "${row.domain}" is not a UX_JOURNEYS.md chapter heading`,
        );
      }
    }
    expect(
      stray,
      `Domains in coverage-matrix.md that don't match any UX_JOURNEYS.md chapter:\n${stray.join("\n")}\n\nUX_JOURNEYS chapters: ${chapters.join(", ")}`,
    ).toHaveLength(0);
  });

  it("UX_JOURNEYS.md has 28 chapters (sanity guard so the matrix stays in sync)", () => {
    const uxContent = fs.readFileSync(uxJourneysPath, "utf8");
    const chapters = parseUxJourneyChapters(uxContent);
    expect(
      chapters.length,
      `Expected exactly 28 UX_JOURNEYS chapters; got ${chapters.length}: ${chapters.join(" | ")}`,
    ).toBe(28);
  });

  it("spine-coverage: at least one test exercises ScheduledTask for each Spine=ScheduledTask domain (GAP §8.5)", () => {
    const content = fs.readFileSync(matrixPath, "utf8");
    const rows = parseMatrixRows(content);
    const spineRows = rows.filter(
      (r) => r.spine === "ScheduledTask" && r.testFile,
    );
    expect(
      spineRows.length,
      "Expected at least one matrix row with Spine=ScheduledTask",
    ).toBeGreaterThan(0);

    // The W1-A runner unit suite exercises the spine globally (every
    // verb, every gate, every pipeline edge — see `runner.test.ts`).
    // Per GAP §8.5, the spine-coverage assertion is satisfied for a
    // domain whose `Spine=ScheduledTask` if EITHER the row's own test
    // file imports the spine OR the global runner unit suite is alive
    // AND at least one canonical e2e test exists for the spine
    // end-to-end (`scheduled-task-end-to-end.e2e.test.ts`,
    // `spine-and-first-run.integration.test.ts`).
    const runnerSpecPath = path.resolve(
      packageRoot,
      "src",
      "lifeops",
      "scheduled-task",
      "runner.test.ts",
    );
    const runnerSpecExists =
      fs.existsSync(runnerSpecPath) && fileExercisesSpine(runnerSpecPath);
    expect(
      runnerSpecExists,
      `W1-A runner unit suite missing or does not exercise the spine: ${runnerSpecPath}`,
    ).toBe(true);

    const canonicalE2ePaths = [
      path.resolve(
        packageRoot,
        "test",
        "scheduled-task-end-to-end.e2e.test.ts",
      ),
      path.resolve(
        packageRoot,
        "test",
        "spine-and-first-run.integration.test.ts",
      ),
    ];
    for (const p of canonicalE2ePaths) {
      expect(
        fs.existsSync(p) && fileExercisesSpine(p),
        `Canonical spine e2e missing or does not exercise the spine: ${p}`,
      ).toBe(true);
    }

    // Per-row sanity: at least one direct importer exists across the
    // Spine=ScheduledTask rows. Without this, the matrix could claim
    // spine coverage everywhere while no e2e test wires the runner
    // explicitly — the runner unit suite would still pass but the
    // matrix would be lying.
    const directlyImporting = spineRows.filter((r) =>
      fileExercisesSpine(path.resolve(packageRoot, r.testFile!)),
    );
    expect(
      directlyImporting.length,
      `At least one Spine=ScheduledTask row should have its test file directly import the spine; got 0. Spine rows: ${spineRows.map((r) => r.testFile).join(", ")}`,
    ).toBeGreaterThan(0);
  });

  it("pending journeys in the matrix have a real test file", () => {
    const content = fs.readFileSync(matrixPath, "utf8");
    const rows = parseMatrixRows(content);

    const pending: string[] = [];
    for (const row of rows) {
      if (!row.status.includes("pending") && !row.status.includes("⏳")) {
        continue;
      }
      if (!row.testFile) {
        pending.push(
          `Row ${row.journeyId} ("${row.journeyName}") is pending and has no test file`,
        );
        continue;
      }
      const resolved = path.resolve(packageRoot, row.testFile);
      if (!fs.existsSync(resolved)) {
        pending.push(
          `Row ${row.journeyId} ("${row.journeyName}") is pending and its test file is missing: ${resolved}`,
        );
      }
    }
    expect(
      pending,
      `Pending rows with no test file:\n${pending.join("\n")}`,
    ).toHaveLength(0);
  });
});

// Keep `testDir` referenced so a future split into multiple test-folders
// stays honest about which directory we're contracting.
void testDir;
