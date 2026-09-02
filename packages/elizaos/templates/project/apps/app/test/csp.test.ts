import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const indexHtml = readFileSync(
  join(import.meta.dirname, "..", "index.html"),
  "utf8",
);

describe("generated app CSP", () => {
  it("allows authenticated view bundles to execute from temporary module URLs", () => {
    const csp = indexHtml.match(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([\s\S]*?)"\s*\/>/iu,
    )?.[1];
    const scriptSrc = csp?.match(/script-src ([^;]+);/)?.[1];

    expect(scriptSrc?.split(/\s+/)).toContain("blob:");
  });
});
