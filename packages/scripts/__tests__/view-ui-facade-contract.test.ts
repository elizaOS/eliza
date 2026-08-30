/**
 * Exercises named-export parity for real authoritative plugin-view graphs and
 * deterministic parser fixtures covering runtime versus type-only imports.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  auditViewUiFacadeImports,
  collectNamedUiFacadeImports,
  findUiFacadeImportViolations,
} from "../lib/view-ui-facade-contract.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");

describe("plugin-view UI facade contract", () => {
  test("distinguishes erased type imports from required runtime values", () => {
    const imports = collectNamedUiFacadeImports(
      `
        import {
          RuntimeValue,
          TypeExport,
          type TypeExport as TypeReference,
          type MissingType,
        } from "@elizaos/ui";
      `,
      { file: "fixture/view.tsx", owner: "plugin-fixture" },
    );
    const violations = findUiFacadeImportViolations(imports, [
      {
        id: "fixture-root",
        specifier: "@elizaos/ui",
        exports: new Map([
          ["RuntimeValue", { runtime: true }],
          ["TypeExport", { runtime: false }],
        ]),
      },
    ]);

    expect(violations).toEqual([
      expect.objectContaining({
        imported: "TypeExport",
        importKind: "runtime",
        reason: "runtime-export-required",
      }),
      expect.objectContaining({
        imported: "MissingType",
        importKind: "type",
        reason: "missing-export",
      }),
    ]);
    expect(
      violations.some(
        ({ imported, importKind }) =>
          imported === "TypeExport" && importKind === "type",
      ),
    ).toBe(false);
  });

  test("every authoritative production view import exists on its browser and host facades", () => {
    const result = auditViewUiFacadeImports({ repoRoot: REPOSITORY_ROOT });

    expect(result.targetCount).toBeGreaterThan(0);
    expect(result.sourceCount).toBeGreaterThan(0);
    expect(result.importCount).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  }, 30_000);
});
