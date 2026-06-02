import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("facewear visual copy", () => {
  it("keeps the XR view on shell theme tokens instead of a custom hardcoded palette", () => {
    const source = readSource("ui/FacewearXrView.tsx");

    expect(source).toContain("bg-bg");
    expect(source).toContain("text-txt");
    expect(source).toContain("border-border");
    expect(source).not.toContain("#0a0a0c");
    expect(source).not.toContain("#6366f1");
    expect(source).not.toContain("#a1a1aa");
    expect(source).not.toContain("rgba(");
    expect(source).not.toContain("<p");
  });

  it("does not render redundant helper copy under the Facewear header", () => {
    const source = readSource("ui/FacewearView.tsx");

    expect(source).not.toContain(
      "Manage all connected XR devices and smartglasses.",
    );
  });
});
