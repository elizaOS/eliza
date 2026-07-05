/**
 * Guards @elizaos/agent source against relative imports that escape the
 * package root (e.g. "../../../core/src/…"): tsc emits the pulled-in sibling
 * sources as gitignored .js litter inside the sibling's src/ and the built
 * dist then depends on that litter existing at runtime (#13515). Real walker
 * over the real src tree plus a fixture proving the walker detects the
 * failure signature.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findCrossPackageImports } from "../../scripts/assert-package-boundary-imports.mjs";

describe("package boundary imports", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects relative imports that escape the package root", () => {
    const packageRoot = mkdtempSync(path.join(os.tmpdir(), "boundary-"));
    tempRoots.push(packageRoot);
    const apiDir = path.join(packageRoot, "src", "api");
    mkdirSync(apiDir, { recursive: true });
    writeFileSync(
      path.join(apiDir, "inbox-routes.ts"),
      [
        `import { helper } from "../shared/helper.ts";`,
        `import {`,
        `  resolveEffectiveMuteState,`,
        `} from "../../../core/src/services/message/mute-state.ts";`,
        `export const x = [helper, resolveEffectiveMuteState];`,
      ].join("\n"),
    );

    expect(findCrossPackageImports(packageRoot)).toEqual([
      {
        file: path.join("src", "api", "inbox-routes.ts"),
        line: 4,
        specifier: "../../../core/src/services/message/mute-state.ts",
      },
    ]);
  });

  it("has no cross-package relative imports in packages/agent/src", () => {
    expect(findCrossPackageImports()).toEqual([]);
  });
});
