/**
 * Regression lock for the OCR-triage provenance scoping (#15790): proves the
 * screenshot set an OCR run consumes is derived from `report.json` and can never
 * absorb a stale PNG left by an earlier capture. Pure functions over injected
 * file-existence and hand-authored records — no OCR engine, no real screenshots.
 */
import { describe, expect, it } from "vitest";
import {
  type AuditReportRow,
  resolveAuditScreenshots,
  selectOcrRecordsForShots,
  shotKeyOfPath,
} from "../../scripts/ocr-triage-lib";

const AUDIT_DIR = "/audit-out";

function report(...rows: [string, string][]): AuditReportRow[] {
  return rows.map(([slug, viewport]) => ({
    slug,
    viewport,
    viewType: "gui" as const,
    verdict: "good",
  }));
}

describe("resolveAuditScreenshots (#15790)", () => {
  it("resolves exactly one screenshot per report row and ignores stale PNGs on disk", () => {
    const rows = report(
      ["builtin-chat", "mobile-portrait"],
      ["builtin-settings", "desktop-landscape"],
    );
    const currentPaths = new Set([
      `${AUDIT_DIR}/mobile-portrait/builtin-chat.png`,
      `${AUDIT_DIR}/desktop-landscape/builtin-settings.png`,
    ]);
    // A since-removed view (Social Alpha) and an older crash still sit in the
    // dir; `existsSync` would report them, but they are not report rows.
    const stalePaths = new Set([
      `${AUDIT_DIR}/mobile-portrait/plugin-social-alpha-gui.png`,
      `${AUDIT_DIR}/desktop-landscape/plugin-polymarket-gui.png`,
    ]);
    const fileExists = (p: string) => currentPaths.has(p) || stalePaths.has(p);

    const shots = resolveAuditScreenshots(rows, AUDIT_DIR, fileExists);

    expect(shots).toHaveLength(rows.length);
    expect(shots.map((s) => s.path)).toEqual([...currentPaths]);
    // No resolved shot points at a stale PNG.
    for (const shot of shots) expect(stalePaths.has(shot.path)).toBe(false);
  });

  it("throws on a duplicate report row", () => {
    const rows = report(
      ["builtin-chat", "mobile-portrait"],
      ["builtin-chat", "mobile-portrait"],
    );
    expect(() => resolveAuditScreenshots(rows, AUDIT_DIR, () => true)).toThrow(
      /duplicate report row builtin-chat::mobile-portrait/,
    );
  });

  it("throws when a report row has no backing screenshot", () => {
    const rows = report(["builtin-chat", "mobile-portrait"]);
    expect(() => resolveAuditScreenshots(rows, AUDIT_DIR, () => false)).toThrow(
      /no screenshot at .*builtin-chat\.png/,
    );
  });
});

describe("selectOcrRecordsForShots (#15790)", () => {
  const rows = report(
    ["builtin-chat", "mobile-portrait"],
    ["builtin-settings", "desktop-landscape"],
  );
  const shots = resolveAuditScreenshots(rows, AUDIT_DIR, () => true);

  it("picks records in report order and drops stale precomputed records", () => {
    const records = [
      // deliberately out of order + one stale record for a removed view
      {
        path: `${AUDIT_DIR}/desktop-landscape/builtin-settings.png`,
        id: "settings",
      },
      {
        path: `${AUDIT_DIR}/mobile-portrait/plugin-social-alpha-gui.png`,
        id: "stale",
      },
      { path: `${AUDIT_DIR}/mobile-portrait/builtin-chat.png`, id: "chat" },
    ];
    const picked = selectOcrRecordsForShots(shots, records);
    expect(picked.map((r) => r.id)).toEqual(["chat", "settings"]);
  });

  it("throws when a report row has no precomputed record", () => {
    const records = [
      { path: `${AUDIT_DIR}/mobile-portrait/builtin-chat.png`, id: "chat" },
    ];
    expect(() => selectOcrRecordsForShots(shots, records)).toThrow(
      /no record for report row builtin-settings::desktop-landscape/,
    );
  });
});

describe("shotKeyOfPath", () => {
  it("maps <viewport>/<slug>.png to slug::viewport", () => {
    expect(shotKeyOfPath(`${AUDIT_DIR}/mobile-portrait/builtin-chat.png`)).toBe(
      "builtin-chat::mobile-portrait",
    );
  });
});
