import { describe, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import * as ts from "typescript";

const API_ROOT = path.resolve(
  import.meta.dir,
  "../../../../apps/web/src/app/api",
);

const HTTP_METHOD_EXPORTS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
]);

async function listRouteFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRouteFiles(fullPath)));
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name === "route.ts" || entry.name === "route.tsx")
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

function getScriptKind(filePath: string): ts.ScriptKind {
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function isExported(node: {
  modifiers?: ts.NodeArray<ts.ModifierLike>;
}): boolean {
  return Boolean(
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function isWithErrorHandlingCall(expr: ts.Expression | undefined): boolean {
  if (!expr || !ts.isCallExpression(expr)) return false;

  const callee = expr.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text === "withErrorHandling";
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text === "withErrorHandling";
  }

  return false;
}

describe("apps/web API routes", () => {
  it("wraps all exported HTTP handlers with withErrorHandling()", async () => {
    const routeFiles = await listRouteFiles(API_ROOT);
    const violations: string[] = [];

    for (const filePath of routeFiles) {
      const text = await fs.readFile(filePath, "utf8");
      const sourceFile = ts.createSourceFile(
        filePath,
        text,
        ts.ScriptTarget.Latest,
        true,
        getScriptKind(filePath),
      );

      for (const statement of sourceFile.statements) {
        if (
          ts.isFunctionDeclaration(statement) &&
          statement.name &&
          HTTP_METHOD_EXPORTS.has(statement.name.text) &&
          isExported(statement)
        ) {
          violations.push(
            `${path.relative(process.cwd(), filePath)}: ${statement.name.text} exported as function (must be wrapped via withErrorHandling)`,
          );
        }

        if (ts.isVariableStatement(statement) && isExported(statement)) {
          for (const decl of statement.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name)) continue;
            const exportName = decl.name.text;
            if (!HTTP_METHOD_EXPORTS.has(exportName)) continue;

            if (!isWithErrorHandlingCall(decl.initializer)) {
              violations.push(
                `${path.relative(process.cwd(), filePath)}: ${exportName} export is not wrapped via withErrorHandling`,
              );
            }
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          "All Next.js App Router API route exports (GET/POST/...) must be wrapped via withErrorHandling().",
          ...violations.sort(),
        ].join("\n"),
      );
    }
  });
});
