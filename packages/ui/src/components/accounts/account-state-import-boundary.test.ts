/**
 * Account components are consumed as a browser-facing package subpath. Keep
 * their selector dependency on the narrow store so importing an account
 * component does not evaluate the broad state barrel and its unrelated runtime
 * modules.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const selectorConsumers = [
  "AccountCard.tsx",
  "AccountCommandTable.tsx",
  "AccountList.tsx",
  "AccountManagementPanel.tsx",
  "AddAccountDialog.tsx",
  "ProviderAccountRow.tsx",
  "ProviderPicker.tsx",
  "RotationStrategyPicker.tsx",
] as const;

function importedNamesByModule(source: string, fileName: string) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const imports = new Map<string, Set<string>>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }

    const names = new Set<string>();
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        names.add(element.propertyName?.text ?? element.name.text);
      }
    }
    imports.set(statement.moduleSpecifier.text, names);
  }

  return imports;
}

describe("account component state imports", () => {
  it.each(selectorConsumers)(
    "%s imports useAppSelector from the browser-safe store",
    (fileName) => {
      const source = readFileSync(
        resolve(import.meta.dirname, fileName),
        "utf8",
      );
      const imports = importedNamesByModule(source, fileName);

      expect(imports.get("../../state/app-store")).toContain("useAppSelector");
      expect(imports.has("../../state")).toBe(false);
      expect(imports.has("../../state/index")).toBe(false);
      expect(imports.has("../../state/index.js")).toBe(false);
    },
  );

  it("ignores import-like comments and strings", () => {
    const imports = importedNamesByModule(
      `
        // import { useAppSelector } from "../../state/app-store";
        const example = 'import { useAppSelector } from "../../state/app-store";';
      `,
      "ImportLookalikes.tsx",
    );

    expect(imports.has("../../state/app-store")).toBe(false);
  });
});
