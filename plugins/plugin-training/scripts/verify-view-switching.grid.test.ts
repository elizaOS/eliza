import { describe, expect, it } from "vitest";
import { buildResultGrid, type GridRow } from "./verify-view-switching.ts";

// Hand-built fixture spanning 2 views × 2 languages × 2 modalities with mixed
// pass/fail, deliberately omitting one combination so the grid must report an
// "absent" cell rather than inventing a status.
const ROWS: GridRow[] = [
  { view: "calendar", language: "en", modality: "text", landedOk: true },
  { view: "calendar", language: "en", modality: "voice", landedOk: false },
  { view: "calendar", language: "es", modality: "text", landedOk: true },
  // calendar / es / voice intentionally omitted -> absent
  { view: "wallet", language: "en", modality: "text", landedOk: false },
  { view: "wallet", language: "en", modality: "voice", landedOk: true },
  { view: "wallet", language: "es", modality: "text", landedOk: true },
  { view: "wallet", language: "es", modality: "voice", landedOk: true },
];

describe("buildResultGrid", () => {
  it("cross-tabulates rows into a per-(view, language, modality) grid", () => {
    const result = buildResultGrid(ROWS);

    expect(result.views).toEqual(["calendar", "wallet"]);
    expect(result.languages).toEqual(["en", "es"]);
    expect(result.modalities).toEqual(["text", "voice"]);

    // pass / fail / absent are each represented in the nested grid.
    expect(result.grid.calendar.en.text).toBe("pass");
    expect(result.grid.calendar.en.voice).toBe("fail");
    expect(result.grid.calendar.es.text).toBe("pass");
    expect(result.grid.calendar.es.voice).toBe("absent");
    expect(result.grid.wallet.en.text).toBe("fail");
    expect(result.grid.wallet.en.voice).toBe("pass");
    expect(result.grid.wallet.es.text).toBe("pass");
    expect(result.grid.wallet.es.voice).toBe("pass");
  });

  it("emits one flat cell per (view × language × modality) combination", () => {
    const result = buildResultGrid(ROWS);

    // 2 views × 2 languages × 2 modalities = 8 cells, even with one absent.
    expect(result.cells).toHaveLength(8);

    const cell = (view: string, language: string, modality: string) =>
      result.cells.find(
        (c) =>
          c.view === view && c.language === language && c.modality === modality,
      );

    expect(cell("calendar", "es", "voice")?.status).toBe("absent");
    expect(cell("calendar", "en", "text")?.status).toBe("pass");
    expect(cell("wallet", "en", "text")?.status).toBe("fail");

    // The flat cells and the nested grid agree everywhere.
    for (const c of result.cells) {
      expect(result.grid[c.view][c.language][c.modality]).toBe(c.status);
    }
  });

  it("marks a combination as fail when any covering row fails (fail dominates)", () => {
    const result = buildResultGrid([
      { view: "inbox", language: "en", modality: "text", landedOk: true },
      { view: "inbox", language: "en", modality: "text", landedOk: false },
    ]);

    expect(result.grid.inbox.en.text).toBe("fail");
    expect(result.cells).toHaveLength(1);
  });
});
