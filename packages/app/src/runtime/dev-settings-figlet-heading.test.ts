/**
 * Direct unit coverage for the Node-only figlet heading printed above each
 * dev-settings table. Drives the real module (figlet is a package dependency);
 * expectations are the strings this checkout produced, including the boxed
 * marker emitted when the requested font is missing.
 */
import { describe, expect, it } from "vitest";
import {
  type DevSubsystemBannerKind,
  prependDevSubsystemFigletHeading,
  renderDevSubsystemFigletHeading,
} from "./dev-settings-figlet-heading";

const STANDARD_HEADINGS: Record<DevSubsystemBannerKind, string[]> = {
  orchestrator: [
    "   ___  ____   ____ _   _ _____ ____ _____ ____      _  _____ ___  ____  ",
    "  / _ \\|  _ \\ / ___| | | | ____/ ___|_   _|  _ \\    / \\|_   _/ _ \\|  _ \\ ",
    " | | | | |_) | |   | |_| |  _| \\___ \\ | | | |_) |  / _ \\ | || | | | |_) |",
    " | |_| |  _ <| |___|  _  | |___ ___) || | |  _ <  / ___ \\| || |_| |  _ < ",
    "  \\___/|_| \\_\\\\____|_| |_|_____|____/ |_| |_| \\_\\/_/   \\_\\_| \\___/|_| \\_\\",
  ],
  vite: [
    " __     _____ _____ _____ ",
    " \\ \\   / /_ _|_   _| ____|",
    "  \\ \\ / / | |  | | |  _|  ",
    "   \\ V /  | |  | | | |___ ",
    "    \\_/  |___| |_| |_____|",
  ],
  api: [
    "     _    ____ ___ ",
    "    / \\  |  _ \\_ _|",
    "   / _ \\ | |_) | | ",
    "  / ___ \\|  __/| | ",
    " /_/   \\_\\_|  |___|",
  ],
  electrobun: [
    "  _____ _     _____ ____ _____ ____   ___  ____  _   _ _   _ ",
    " | ____| |   | ____/ ___|_   _|  _ \\ / _ \\| __ )| | | | \\ | |",
    " |  _| | |   |  _|| |     | | | |_) | | | |  _ \\| | | |  \\| |",
    " | |___| |___| |__| |___  | | |  _ <| |_| | |_) | |_| | |\\  |",
    " |_____|_____|_____\\____| |_| |_| \\_\\\\___/|____/ \\___/|_| \\_|",
  ],
};

const BOXED_FALLBACK: Record<DevSubsystemBannerKind, string> = {
  orchestrator: " ______________ \n| ORCHESTRATOR |\n|______________|",
  vite: " ______ \n| VITE |\n|______|",
  api: " _____ \n| API |\n|_____|",
  electrobun: " ____________ \n| ELECTROBUN |\n|____________|",
};

const KINDS = Object.keys(STANDARD_HEADINGS) as DevSubsystemBannerKind[];

const MISSING_FONT = "ThisFontDoesNotExistXYZ";

describe("renderDevSubsystemFigletHeading", () => {
  it.each(KINDS)("renders the Standard-font figlet block for %s", (kind) => {
    expect(renderDevSubsystemFigletHeading(kind).split("\n")).toEqual(
      STANDARD_HEADINGS[kind],
    );
  });

  it("strips only trailing whitespace from the finished block", () => {
    for (const kind of KINDS) {
      const out = renderDevSubsystemFigletHeading(kind);
      expect(out).toBe(STANDARD_HEADINGS[kind].join("\n"));
      expect(out).not.toMatch(/\s$/u);
    }
  });

  it("treats omitted options, an empty object, and the documented defaults as the same", () => {
    const omitted = renderDevSubsystemFigletHeading("api");
    expect(renderDevSubsystemFigletHeading("api", {})).toBe(omitted);
    expect(renderDevSubsystemFigletHeading("api", { maxWidth: 80 })).toBe(
      omitted,
    );
    expect(renderDevSubsystemFigletHeading("api", { font: "Standard" })).toBe(
      omitted,
    );
    expect(
      renderDevSubsystemFigletHeading("api", {
        maxWidth: 80,
        font: "Standard",
      }),
    ).toBe(omitted);
  });

  it("accepts the Small font as a distinct shorter block", () => {
    const small = renderDevSubsystemFigletHeading("api", { font: "Small" });
    expect(small.split("\n")).toEqual([
      "    _   ___ ___ ",
      "   /_\\ | _ \\_ _|",
      "  / _ \\|  _/| | ",
      " /_/ \\_\\_| |___|",
    ]);
    expect(small).not.toBe(renderDevSubsystemFigletHeading("api"));
  });

  it("wraps the figlet block when maxWidth is narrower than the Standard line", () => {
    const wrapped = renderDevSubsystemFigletHeading("api", { maxWidth: 10 });
    expect(wrapped.split("\n")).toEqual([
      "     _    ",
      "    / \\   ",
      "   / _ \\  ",
      "  / ___ \\ ",
      " /_/__ \\_\\",
      " |  _ \\   ",
      " | |_) |  ",
      " |  __/   ",
      " |_|_     ",
      " |_ _|    ",
      "  | |     ",
      "  | |     ",
      " |___|",
    ]);
    expect(wrapped.split("\n").length).toBeGreaterThan(
      STANDARD_HEADINGS.api.length,
    );
  });

  it("leaves wrapping unchanged for non-positive maxWidth (figlet treats them as default)", () => {
    const omitted = renderDevSubsystemFigletHeading("api");
    expect(renderDevSubsystemFigletHeading("api", { maxWidth: 0 })).toBe(
      omitted,
    );
    expect(renderDevSubsystemFigletHeading("api", { maxWidth: -1 })).toBe(
      omitted,
    );
  });

  it("treats an empty font name as the Standard default rather than the boxed fallback", () => {
    expect(renderDevSubsystemFigletHeading("api", { font: "" })).toBe(
      renderDevSubsystemFigletHeading("api"),
    );
  });

  it.each(KINDS)(
    "falls back to the boxed marker when the requested font is missing for %s",
    (kind) => {
      const out = renderDevSubsystemFigletHeading(kind, {
        font: MISSING_FONT,
      });
      expect(out).toBe(BOXED_FALLBACK[kind]);
      expect(out.split("\n")).toHaveLength(3);
    },
  );
});

describe("prependDevSubsystemFigletHeading", () => {
  it("joins the heading and table with a single blank line", () => {
    const head = renderDevSubsystemFigletHeading("api");
    expect(prependDevSubsystemFigletHeading("api", "| table |")).toBe(
      `${head}\n\n| table |`,
    );
  });

  it("keeps an empty table as a trailing blank line after the heading", () => {
    const head = renderDevSubsystemFigletHeading("vite");
    expect(prependDevSubsystemFigletHeading("vite", "")).toBe(`${head}\n\n`);
  });

  it("preserves table newlines rather than flattening them", () => {
    const head = renderDevSubsystemFigletHeading("api");
    expect(prependDevSubsystemFigletHeading("api", "row1\nrow2")).toBe(
      `${head}\n\nrow1\nrow2`,
    );
    expect(prependDevSubsystemFigletHeading("api", "\nfooter")).toBe(
      `${head}\n\n\nfooter`,
    );
  });

  it("forwards font and maxWidth into the heading used above the table", () => {
    const head = renderDevSubsystemFigletHeading("electrobun", {
      font: MISSING_FONT,
      maxWidth: 40,
    });
    expect(
      prependDevSubsystemFigletHeading("electrobun", "T", {
        font: MISSING_FONT,
        maxWidth: 40,
      }),
    ).toBe(`${head}\n\nT`);
    expect(head).toBe(BOXED_FALLBACK.electrobun);
  });
});
