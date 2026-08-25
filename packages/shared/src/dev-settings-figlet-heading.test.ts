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

describe("dev-settings-figlet-heading", () => {
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
    expect(lines[1]).toBe(`| ${kind.toUpperCase()} |`);
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
