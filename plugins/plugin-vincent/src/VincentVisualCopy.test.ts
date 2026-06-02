import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("VincentAppView visual copy", () => {
  it("does not render redundant header helper copy", () => {
    const source = readFileSync(resolve(here, "VincentAppView.tsx"), "utf8");

    expect(source).not.toContain("Hyperliquid and Polymarket trading access");
  });
});
