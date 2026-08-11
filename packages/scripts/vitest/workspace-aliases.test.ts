/**
 * Verifies shared Vitest aliases prefer live workspace sources over sibling
 * package build artifacts.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

import { repoRoot } from "./repo-root.ts";
import {
  getAgentSourceAliases,
  getUiSourceAliases,
} from "./workspace-aliases.ts";

describe("agent workspace source aliases", () => {
  it("leaves subpaths extensionless so files and directory exports both resolve", () => {
    const sourceRoot = path.join(repoRoot, "packages/agent/src");
    const aliases = getAgentSourceAliases(sourceRoot);
    const subpathAlias = aliases.find(
      (alias) => String(alias.find) === String(/^@elizaos\/agent\/(.+)$/),
    );

    expect(subpathAlias?.replacement).toBe(path.join(sourceRoot, "$1"));
  });
});

describe("UI workspace source aliases", () => {
  it("maps exact package exports to source when a matching source entry exists", () => {
    const aliases = getUiSourceAliases(path.join(repoRoot, "packages/ui/src"));
    const spatialAlias = aliases.find(
      (alias) => String(alias.find) === String(/^@elizaos\/ui\/spatial$/),
    );

    expect(spatialAlias?.replacement).toBe(
      path.join(repoRoot, "packages/ui/src/spatial/index.ts"),
    );
  });
});
