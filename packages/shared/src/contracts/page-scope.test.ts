import { describe, expect, it } from "vitest";

import { isPageScope, PAGE_SCOPES } from "./page-scope.js";

describe("page-scope contract", () => {
  it("accepts every declared page scope", () => {
    for (const scope of PAGE_SCOPES) {
      expect(isPageScope(scope)).toBe(true);
    }
  });

  it("rejects well-formed but undeclared scopes", () => {
    expect(isPageScope("page-admin")).toBe(false);
    expect(isPageScope("page-browser-extra")).toBe(false);
  });

  it("rejects non-page-scope values", () => {
    expect(isPageScope("wallet")).toBe(false);
    expect(isPageScope("page-<script>")).toBe(false);
    expect(isPageScope(42)).toBe(false);
    expect(isPageScope(null)).toBe(false);
  });
});
