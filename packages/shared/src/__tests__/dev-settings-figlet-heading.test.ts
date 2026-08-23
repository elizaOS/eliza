import { describe, expect, it } from "vitest";
import {
  prependDevSubsystemFigletHeading,
  renderDevSubsystemFigletHeading,
} from "../dev-settings-figlet-heading.ts";

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
});

describe("prependDevSubsystemFigletHeading", () => {
  it("separates heading from the table with a blank line", () => {
    const out = prependDevSubsystemFigletHeading("api", "| table |");
    const parts = out.split("\n\n");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("API");
    expect(parts[1]).toBe("| table |");
  });
});
