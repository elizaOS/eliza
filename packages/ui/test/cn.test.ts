import { expect, test, vi } from "vitest";

// A tokens.json that declares the scales, which @repo/design-system's own does not yet.
vi.mock("@repo/design-system/tokens.json", () => ({
  default: { text: { body: "1rem" }, weight: { strong: "650" }, leading: { snug: "1.3" }, tracking: { wide: "0.02em" }, z: { overlay: "40" } },
}));
const { cn } = await import("../src/lib/cn.ts");

// [inputs, merged]: the mocked scales are not in the theme this package's lint reads, so they stay out of a cn() literal.
const cases: [string[], string][] = [
  [["font-bold", "font-strong"], "font-strong"],
  [["z-10", "z-overlay"], "z-overlay"],
  [["leading-6", "leading-snug"], "leading-snug"],
  [["tracking-tight", "tracking-wide"], "tracking-wide"],
  [["text-sm", "text-body"], "text-body"],
  [["text-body", "text-primary"], "text-body text-primary"],
];

test("a token of a scale replaces Tailwind's own class of that scale, and a size never replaces a color", () => {
  for (const [inputs, merged] of cases) expect(cn(...inputs), inputs.join(" ")).toBe(merged);
});
