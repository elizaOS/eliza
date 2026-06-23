import { describe, expect, it } from "vitest";
import {
  bucket,
  computeVerdict,
  OVERLAY_NATIVE_OR_CANVAS_SLUGS,
  parseNavigationTabPaths,
  parseRgb,
  type VerdictFinding,
} from "../ui-smoke/aesthetic-audit-rules";

describe("parseRgb (#8796)", () => {
  it("parses rgb() and rgba(), defaulting alpha to 1", () => {
    expect(parseRgb("rgb(255, 0, 0)")).toEqual([255, 0, 0, 1]);
    expect(parseRgb("rgba(0, 0, 0, 0.5)")).toEqual([0, 0, 0, 0.5]);
  });
  it("returns null for non-rgb strings", () => {
    expect(parseRgb("transparent")).toBeNull();
    expect(parseRgb("rgb(1, 2)")).toBeNull();
    expect(parseRgb("#fff")).toBeNull();
  });
});

describe("bucket (#8796 no-blue / orange detection)", () => {
  it("buckets the brand orange as orange", () => {
    expect(bucket("rgb(230, 126, 34)")).toBe("orange");
  });
  it("buckets a blue as blue (the banned color)", () => {
    expect(bucket("rgb(40, 90, 230)")).toBe("blue");
  });
  it("buckets near-black and pure white", () => {
    expect(bucket("rgb(10, 10, 10)")).toBe("black");
    expect(bucket("rgb(255, 255, 255)")).toBe("white");
  });
  it("buckets fully transparent and low-saturation gray", () => {
    expect(bucket("rgba(0, 0, 255, 0)")).toBe("transparent");
    expect(bucket("rgb(128, 128, 128)")).toBe("neutral");
  });
  it("unparseable colors fall back to neutral (never blue)", () => {
    expect(bucket("not-a-color")).toBe("neutral");
  });
});

describe("parseNavigationTabPaths (#8796)", () => {
  it("extracts the TAB_PATHS map (quoted and unquoted keys)", () => {
    const src = `
      type BuiltinTab = "home" | "chat";
      export const TAB_PATHS: Record<BuiltinTab, string> = {
        home: "/",
        "chat": "/chat",
      };
    `;
    expect(parseNavigationTabPaths(src)).toEqual({ home: "/", chat: "/chat" });
  });
  it("throws when TAB_PATHS is absent", () => {
    expect(() => parseNavigationTabPaths("export const X = 1;")).toThrow(
      /could not locate TAB_PATHS/,
    );
  });
});

describe("computeVerdict (#8796 verdict precedence)", () => {
  const finding = (o: Partial<VerdictFinding> = {}): VerdictFinding => ({
    slug: "plugin-foo-gui",
    viewType: "gui",
    consoleErrors: [],
    qualityIssues: [],
    readableChars: 500,
    blueColors: [],
    hoverViolations: [],
    overlayPresent: true,
    borderRadiusViolations: [],
    ...o,
  });

  it("a clean gui view is good", () => {
    expect(computeVerdict(finding())).toBe("good");
  });

  it("any console error is broken — even on an exempt surface", () => {
    expect(computeVerdict(finding({ consoleErrors: ["boom"] }))).toBe("broken");
    expect(
      computeVerdict(finding({ viewType: "tui", consoleErrors: ["boom"] })),
    ).toBe("broken");
  });

  it("a gui view with quality issues or no readable content is broken", () => {
    expect(computeVerdict(finding({ qualityIssues: ["blurry"] }))).toBe(
      "broken",
    );
    expect(computeVerdict(finding({ readableChars: 0 }))).toBe("broken");
  });

  it("TUI and overlay surfaces are exempt from the quality/content floors", () => {
    expect(
      computeVerdict(
        finding({ viewType: "tui", qualityIssues: ["x"], readableChars: 0 }),
      ),
    ).toBe("good");
    expect(
      computeVerdict(
        finding({
          slug: "builtin-chat",
          qualityIssues: ["x"],
          readableChars: 0,
        }),
      ),
    ).toBe("good");
  });

  it("the no-blue rule still applies to overlay surfaces", () => {
    expect(OVERLAY_NATIVE_OR_CANVAS_SLUGS.has("builtin-chat")).toBe(true);
    expect(
      computeVerdict(
        finding({ slug: "builtin-chat", blueColors: ["rgb(0,0,255)"] }),
      ),
    ).toBe("needs-work");
  });

  it("blue / hover violations / missing overlay are needs-work on a gui view", () => {
    expect(computeVerdict(finding({ blueColors: ["rgb(0,0,255)"] }))).toBe(
      "needs-work",
    );
    expect(computeVerdict(finding({ hoverViolations: ["x"] }))).toBe(
      "needs-work",
    );
    expect(computeVerdict(finding({ overlayPresent: false }))).toBe(
      "needs-work",
    );
  });

  it("off-scale border radius is a soft needs-eyeball (non-blocking)", () => {
    expect(computeVerdict(finding({ borderRadiusViolations: ["32px"] }))).toBe(
      "needs-eyeball",
    );
  });
});
