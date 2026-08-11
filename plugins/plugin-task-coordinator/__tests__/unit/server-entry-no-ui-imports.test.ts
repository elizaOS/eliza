/**
 * Regression contract: the server-side plugin entry (`src/index.ts` →
 * `dist/index.js`) must not statically import any browser-only React components
 * or `@elizaos/ui` modules. The headless cloud agent image loads
 * `dist/index.js` in Node, and the Dockerfile deliberately excludes the
 * `@elizaos/ui` radix/three/recharts tree from the runtime-dep closure. A
 * transitive `@radix-ui/react-slot` import through a re-exported GUI component
 * crashes the plugin at boot with `Cannot find package '@radix-ui/react-slot'`
 * (issue #18031).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRY_PATH = resolve(__dirname, "../../src/index.ts");

describe("server entry — no browser/UI imports (#18031)", () => {
  const source = readFileSync(ENTRY_PATH, "utf8");

  it("does not re-export ProjectSwitcher or other browser-only components", () => {
    // ProjectSwitcher is a React component whose transitive import chain
    // reaches @elizaos/ui → @radix-ui/react-slot. It must only be reachable
    // from the view bundle, not from the server entry.
    expect(source).not.toMatch(
      /export\s+\{[^}]*ProjectSwitcher[^}]*\}/,
    );
  });

  it("does not import from @elizaos/ui", () => {
    // The server entry must not carry a static import of any @elizaos/ui
    // subpath — those pull in browser-only React/radix components.
    expect(source).not.toMatch(/from\s+["']@elizaos\/ui/);
  });

  it("does not import React or react-dom", () => {
    // The server entry has no server-side use of React.
    expect(source).not.toMatch(/from\s+["']react(?:-dom)?["']/);
  });
});
