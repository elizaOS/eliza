/**
 * Parse-only fixture for the tenant-scope gate (#9853 P1.6). Never executed;
 * check-tenant-scope.ts reads it as text. Mirrors a repository doing a pk-only
 * read against a tenant data-plane table WITHOUT a scope annotation — the
 * checker must flag exactly one violation here.
 */
declare const dbRead: { query: { apps: { findFirst(args: unknown): Promise<unknown> } } };
declare function eq(a: unknown, b: unknown): unknown;
declare const apps: { id: unknown; organization_id: unknown };

export class UnscopedFixtureRepo {
  async findById(id: string): Promise<unknown> {
    return await dbRead.query.apps.findFirst({ where: eq(apps.id, id) });
  }
}
