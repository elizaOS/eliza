/** Assign script suites to the runner they import, without duplicate filename lists. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export function discoverScriptTestLanes(appRoot: string) {
  const lanes: Record<"node:test" | "bun:test" | "vitest", string[]> = {
    "node:test": [],
    "bun:test": [],
    vitest: [],
  };
  const scripts = path.join(appRoot, "scripts");
  for (const relative of readdirSync(scripts, { recursive: true }).sort()) {
    if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative)) continue;
    const file = path.join(scripts, relative);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      false,
    );
    const runners = new Set(
      source.statements.flatMap((statement) => {
        if (
          !ts.isImportDeclaration(statement) ||
          statement.importClause?.isTypeOnly ||
          !ts.isStringLiteral(statement.moduleSpecifier)
        )
          return [];
        const name = statement.moduleSpecifier.text;
        return name === "node:test" || name === "bun:test" || name === "vitest"
          ? [name]
          : [];
      }),
    );
    if (runners.size !== 1)
      throw new Error(`Script test must import exactly one runner: ${file}`);
    const runner = [...runners][0] as keyof typeof lanes;
    lanes[runner].push(`scripts/${relative.split(path.sep).join("/")}`);
  }
  return lanes;
}
