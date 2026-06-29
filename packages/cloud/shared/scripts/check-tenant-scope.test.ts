import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findUnscopedTenantReads } from "./check-tenant-scope";

// Each fixture is a tiny repository module; the gate parses it from disk, so we
// write a temp file per case and feed its path to findUnscopedTenantReads. The
// preamble imports the drizzle combinators + tenant table identifiers the gate
// pattern-matches on (only the identifier names matter — never executed).
const PREAMBLE = `
import { and, or, eq, inArray } from "drizzle-orm";
import { apps, appUsers } from "../schemas";
declare const dbRead: any;
`;

let tempDir: string | undefined;

function fixture(body: string): string {
  if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), "tenant-scope-"));
  const file = join(tempDir, `f-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, PREAMBLE + body);
  return file;
}

function flags(body: string): boolean {
  return findUnscopedTenantReads([fixture(body)]).length > 0;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("findUnscopedTenantReads — combinator-wrapped pk-only reads (FLAG)", () => {
  test("bare eq(table.id, id) — the original case", () => {
    expect(
      flags(`function f(id: string) { dbRead.query.apps.findFirst({ where: eq(apps.id, id) }); }`),
    ).toBe(true);
  });

  test("and(eq(table.id, id)) — single-operand combinator wrapper", () => {
    expect(
      flags(
        `function f(id: string) { dbRead.query.apps.findFirst({ where: and(eq(apps.id, id)) }); }`,
      ),
    ).toBe(true);
  });

  test("or(eq(table.id, a), eq(table.id, b)) — all operands pk predicates", () => {
    expect(
      flags(
        `function f(a: string, b: string) { dbRead.query.apps.findFirst({ where: or(eq(apps.id, a), eq(apps.id, b)) }); }`,
      ),
    ).toBe(true);
  });

  test("inArray(table.id, ids) — bulk pk read", () => {
    expect(
      flags(
        `function f(ids: string[]) { dbRead.query.apps.findMany({ where: inArray(apps.id, ids) }); }`,
      ),
    ).toBe(true);
  });

  test("and(inArray(table.id, ids)) — combinator-wrapped bulk pk read", () => {
    expect(
      flags(
        `function f(ids: string[]) { dbRead.query.apps.findMany({ where: and(inArray(apps.id, ids)) }); }`,
      ),
    ).toBe(true);
  });

  test("and(...conditions) where conditions = [eq(table.id, id)] — dynamic spread idiom", () => {
    expect(
      flags(`function f(id: string) {
        const conditions = [eq(apps.id, id)];
        dbRead.query.apps.findFirst({ where: and(...conditions) });
      }`),
    ).toBe(true);
  });

  test("the .where() builder form is caught too", () => {
    expect(
      flags(`function f(id: string) { dbRead.update(apps).set({}).where(and(eq(apps.id, id))); }`),
    ).toBe(true);
  });
});

describe("findUnscopedTenantReads — properly ownership-scoped reads (NO FLAG)", () => {
  test("and(eq(table.id, id), eq(table.organization_id, orgId)) — org-scoped", () => {
    expect(
      flags(`function f(id: string, orgId: string) {
        dbRead.query.apps.findFirst({ where: and(eq(apps.id, id), eq(apps.organization_id, orgId)) });
      }`),
    ).toBe(false);
  });

  test("and(...conditions) carrying an ownership predicate is not flagged", () => {
    expect(
      flags(`function f(id: string, orgId: string) {
        const conditions = [eq(apps.id, id), eq(apps.organization_id, orgId)];
        dbRead.query.apps.findFirst({ where: and(...conditions) });
      }`),
    ).toBe(false);
  });

  test("a non-pk ownership-only read (no id predicate) is not flagged", () => {
    expect(
      flags(`function f(appId: string, userId: string) {
        dbRead.query.appUsers.findFirst({ where: and(eq(appUsers.app_id, appId), eq(appUsers.user_id, userId)) });
      }`),
    ).toBe(false);
  });

  test("a pk read against a NON-tenant table is not flagged", () => {
    expect(
      flags(
        `function f(id: string) { dbRead.query.organizations.findFirst({ where: eq(organizations.id, id) }); }`,
      ),
    ).toBe(false);
  });

  test("a /* global-scope */ annotation opts the method out", () => {
    expect(
      flags(`function f(id: string) {
        /* global-scope: route handler authorizes ownership first. */
        return dbRead.query.apps.findFirst({ where: and(eq(apps.id, id)) });
      }`),
    ).toBe(false);
  });
});

describe("findUnscopedTenantReads — reporting", () => {
  test("reports the table and method name for an unscoped read", () => {
    const violations = findUnscopedTenantReads([
      fixture(
        `function loadApp(id: string) { dbRead.query.apps.findFirst({ where: inArray(apps.id, [id]) }); }`,
      ),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0].table).toBe("apps");
    expect(violations[0].method).toBe("loadApp");
  });
});
