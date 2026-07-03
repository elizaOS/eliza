import { describe, expect, it } from "vitest";
import {
  DYNAMIC_VIEW_IMPORT_GLOBAL,
  parseHostExternalSpecifiers,
  rewriteHostExternalImports,
} from "./dynamic-view-host-external.mjs";

/**
 * `dynamic-view-host-external.mjs` is the single source of the host-external
 * view-import rewrite consumed by BOTH the agent bundle route
 * (`views-routes.ts`) and the Playwright UI-smoke stub. Locking the transform
 * here keeps the two serve paths byte-identical.
 */
describe("rewriteHostExternalImports", () => {
  const specifiers = ["@elizaos/ui", "react", "react/jsx-runtime"];

  it("returns the source unchanged when no specifiers are host-external", () => {
    const src = `import { foo } from "@elizaos/ui";`;
    expect(rewriteHostExternalImports(src, [])).toBe(src);
  });

  it("rewrites a named import into a destructured host-external call", () => {
    const out = rewriteHostExternalImports(
      `import { Button, Input as TextInput } from "@elizaos/ui";`,
      specifiers,
    );
    expect(out).toContain(
      `await globalThis.${DYNAMIC_VIEW_IMPORT_GLOBAL}("@elizaos/ui")`,
    );
    expect(out).toContain("const { Button, Input: TextInput } =");
    expect(out).not.toContain(`from "@elizaos/ui"`);
  });

  it("rewrites a namespace import", () => {
    const out = rewriteHostExternalImports(
      `import * as React from "react";`,
      specifiers,
    );
    expect(out).toContain(
      `await globalThis.${DYNAMIC_VIEW_IMPORT_GLOBAL}("react")`,
    );
    expect(out).toMatch(
      /const React = __eliza_dynamic_view_host_external_\d+;/,
    );
  });

  it("rewrites a default + named import with a .default fallback", () => {
    const out = rewriteHostExternalImports(
      `import React, { useState } from "react";`,
      specifiers,
    );
    expect(out).toMatch(
      /const React = __eliza_dynamic_view_host_external_\d+\.default \?\? __eliza_dynamic_view_host_external_\d+;/,
    );
    expect(out).toContain("const { useState } =");
  });

  it("rewrites a side-effect import", () => {
    const out = rewriteHostExternalImports(
      `import "react/jsx-runtime";`,
      specifiers,
    );
    expect(out).toBe(
      `await globalThis.${DYNAMIC_VIEW_IMPORT_GLOBAL}("react/jsx-runtime");`,
    );
  });

  it("leaves non-host-external imports alone", () => {
    const src = `import { local } from "./local.js";`;
    expect(rewriteHostExternalImports(src, specifiers)).toBe(src);
  });
});

describe("parseHostExternalSpecifiers", () => {
  it("returns [] unless hostExternalRuntime=1", () => {
    const url = new URL(
      "http://x/bundle.js?hostExternalSpecifiers=react,@elizaos/ui",
    );
    expect(parseHostExternalSpecifiers(url)).toEqual([]);
  });

  it("splits and trims the specifier list when enabled", () => {
    const url = new URL(
      "http://x/bundle.js?hostExternalRuntime=1&hostExternalSpecifiers=react, @elizaos/ui ,",
    );
    expect(parseHostExternalSpecifiers(url)).toEqual(["react", "@elizaos/ui"]);
  });
});
