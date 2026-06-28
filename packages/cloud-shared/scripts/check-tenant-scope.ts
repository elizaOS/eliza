/**
 * Static tenant-scope gate (#9853 P1.6, GAP B).
 *
 * Scans the cloud-shared repositories for reads/updates/deletes against the
 * Product-2 *apps tenant data-plane* whose WHERE clause is ONLY the primary-key
 * `id` (`eq(<table>.id, _)`) with no organization/app ownership predicate. Such
 * pk-only access trusts the caller to have already authorized ownership, so a
 * NEW unscoped query against a tenant table must not land silently before GA.
 *
 * A method may opt out with an explicit annotation that documents WHY the
 * lookup is intentionally id-only (e.g. authorization happens in the route
 * handler, or the id was just resolved from an owned row):
 *
 *     /* global-scope: <reason> *\/
 *
 * Scope note: this enforces only the apps surface that #9853 hardens, not every
 * `organization_id` table — the repository layer is pk-based across ~60 tables
 * by design, and blanket-annotating all of them is out of scope for this item.
 *
 * Exits non-zero on any unannotated violation. Importing this module is
 * side-effect-free; only the CLI block below scans the real tree.
 */
import { globSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * The Product-2 apps tenant data-plane: tables holding per-tenant app rows where
 * a cross-tenant id read is the #9853 GA risk. Add new apps-plane tables here as
 * the surface grows; widening the gate to every `organization_id` table is a
 * separate, larger decision (tracked for the lead).
 */
export const TENANT_DATA_PLANE_TABLES = new Set<string>([
  "apps",
  "appUsers",
  "appRequests",
  "appConfig",
  "appDomains",
  "appDatabases",
  "appCreditBalances",
  "appEarnings",
]);

export interface TenantScopeViolation {
  file: string;
  line: number;
  table: string;
  method: string;
}

const ALLOW_ANNOTATION = /global-scope:/;

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

/**
 * If `where` is a SOLE `eq(<table>.id, _)` against a tenant data-plane table,
 * return that table's identifier name; otherwise undefined. An `and(...)`/`or(...)`
 * combinator or a predicate on any other column is — by construction — not a
 * single eq on the pk, so it is never flagged.
 */
function solePrimaryKeyTable(where: ts.Expression): string | undefined {
  if (!ts.isCallExpression(where)) return undefined;
  if (!ts.isIdentifier(where.expression) || where.expression.text !== "eq") return undefined;
  const lhs = where.arguments[0];
  if (!lhs || !ts.isPropertyAccessExpression(lhs)) return undefined;
  if (!ts.isIdentifier(lhs.expression) || lhs.name.text !== "id") return undefined;
  return TENANT_DATA_PLANE_TABLES.has(lhs.expression.text) ? lhs.expression.text : undefined;
}

/** Outermost enclosing function/method: its name (for reporting) and full text.
 * Outermost (not nearest) so one `/* global-scope: *\/` on a repository method
 * opts out every query inside it, including ones nested in `transaction(...)`
 * callbacks. The full text includes leading comments, so the annotation may sit
 * above or inside the method. */
function enclosingFunction(node: ts.Node): { name: string; text: string } {
  let fn: ts.FunctionLikeDeclaration | undefined;
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (
      ts.isMethodDeclaration(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n)
    ) {
      fn = n;
    }
  }
  if (!fn) return { name: "<module>", text: "" };
  const name = fn.name && ts.isIdentifier(fn.name) ? fn.name.text : "<anonymous>";
  return { name, text: fn.getFullText() };
}

/** The WHERE expression of a drizzle query, whether written as the query-builder
 * `.where(expr)` call or the relational `{ where: expr }` option. */
function whereExpression(node: ts.Node): ts.Expression | undefined {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "where" &&
    node.arguments.length === 1
  ) {
    return node.arguments[0];
  }
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "where") {
    return node.initializer;
  }
  return undefined;
}

/**
 * Returns every unannotated pk-only tenant-table access in the given repository
 * files. Pure over the file contents (reads from disk, no other side effects).
 */
export function findUnscopedTenantReads(repoFiles: string[]): TenantScopeViolation[] {
  const violations: TenantScopeViolation[] = [];
  for (const file of repoFiles) {
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      const where = whereExpression(node);
      if (where) {
        const table = solePrimaryKeyTable(where);
        if (table) {
          const fn = enclosingFunction(node);
          if (!ALLOW_ANNOTATION.test(fn.text)) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
            violations.push({ file, line: line + 1, table, method: fn.name });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../src/db/repositories", import.meta.url));
  const files = globSync(`${root}/**/*.ts`).filter((f) => !f.endsWith(".test.ts"));
  const violations = findUnscopedTenantReads(files);

  if (violations.length > 0) {
    console.error(
      `\n✗ tenant-scope gate: ${violations.length} pk-only read(s) against a tenant data-plane table\n`,
    );
    for (const v of violations) {
      console.error(
        `  ${relative(process.cwd(), v.file)}:${v.line}  ${v.method}() → eq(${v.table}.id, …)`,
      );
    }
    console.error(
      "\nScope each query by organization/app ownership, or — if the method is\n" +
        "intentionally id-only (authorization lives in the caller) — annotate it with\n" +
        "  /* global-scope: <reason> */\n",
    );
    process.exit(1);
  }

  console.log(
    `✓ tenant-scope gate: no unannotated pk-only reads across ${files.length} repository file(s)`,
  );
}
