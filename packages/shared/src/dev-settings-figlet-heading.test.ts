/**
 * Unit coverage for dev subsystem figlet headings in dev-settings-figlet-heading.ts.
 *
 * Tests boxed heading generation across all subsystem banner kinds
 * (orchestrator, vite, api, electrobun) and table concatenation.
 */

import { describe, expect, it } from "vitest";
import {
  type DevSubsystemBannerKind,
  prependDevSubsystemFigletHeading,
  renderDevSubsystemFigletHeading,
} from "./dev-settings-figlet-heading.js";

describe("renderDevSubsystemFigletHeading", () => {
  it("renders a boxed marker with the subsystem text", () => {
    const out = renderDevSubsystemFigletHeading("api");
    expect(out).toContain("| API |");
    expect(out.split("\n")).toHaveLength(3);
  });

  it("maps each subsystem kind to its text", () => {
    expect(renderDevSubsystemFigletHeading("orchestrator")).toContain(
      "ORCHESTRATOR",
    );
    expect(renderDevSubsystemFigletHeading("vite")).toContain("VITE");
    expect(renderDevSubsystemFigletHeading("electrobun")).toContain(
      "ELECTROBUN",
    );
  });

  it("box width matches the text length", () => {
    const out = renderDevSubsystemFigletHeading("vite");
    const lines = out.split("\n");
    expect(lines[0].length).toBe(lines[1].length);
  });

  const kinds: DevSubsystemBannerKind[] = [
    "orchestrator",
    "vite",
    "api",
    "electrobun",
  ];

  it.each(kinds)("renders boxed ASCII heading for subsystem '%s'", (kind) => {
    const heading = renderDevSubsystemFigletHeading(kind);

    expect(typeof heading).toBe("string");
    expect(heading.length).toBeGreaterThan(0);
    expect(heading).toContain(kind.toUpperCase());

    const lines = heading.split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0].length).toBe(lines[1].length);
    expect(lines[1]).toBe(`| ${kind.toUpperCase()} |`);
  });
});

describe("prependDevSubsystemFigletHeading", () => {
  it("separates heading from the table with a blank line", () => {
    const out = prependDevSubsystemFigletHeading("api", "| table |");
    const parts = out.split("\n\n");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("API");
    expect(parts[1]).toBe("| table |");
  });

  it("prepends figlet heading above settings table with blank line separation", () => {
    const table = "=== Settings Table ===\nPORT: 3000";
    const combined = prependDevSubsystemFigletHeading("api", table);

    expect(combined.startsWith(" ")).toBe(true);
    expect(combined).toContain("| API |");
    expect(combined).toContain("\n\n=== Settings Table ===");
    expect(combined.endsWith(table)).toBe(true);
  });
});
