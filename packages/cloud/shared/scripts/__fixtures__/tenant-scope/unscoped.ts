/**
 * Parse-only fixture for the tenant-scope gate (#9853 P1.6). Never executed;
 * check-tenant-scope.ts reads it as text. Mirrors a repository doing a pk-only
 * read against a tenant data-plane table WITHOUT a scope annotation — the
 * checker must flag exactly one violation here.
 */
declare const dbRead: { query: { apps: { findFirst(args: unknown): Promise<unknown> } } };
declare function eq(a: unknown, b: unknown): unknown;
declare function and(...parts: unknown[]): unknown;
declare function or(...parts: unknown[]): unknown;
declare function inArray(a: unknown, b: unknown): unknown;
declare const apps: { id: unknown; organization_id: unknown };

export class UnscopedFixtureRepo {
  async findById(id: string): Promise<unknown> {
    return await dbRead.query.apps.findFirst({ where: eq(apps.id, id) });
  }

  async findByIdWrappedInAnd(id: string): Promise<unknown> {
    return await dbRead.query.apps.findFirst({ where: and(eq(apps.id, id)) });
  }

  async findByIdWrappedInOr(id: string): Promise<unknown> {
    return await dbRead.query.apps.findFirst({ where: or(eq(apps.id, id)) });
  }

  async findByIds(ids: string[]): Promise<unknown> {
    return await dbRead.query.apps.findFirst({ where: inArray(apps.id, ids) });
  }

  async findBySpreadConditions(id: string): Promise<unknown> {
    const conditions = [eq(apps.id, id)];
    return await dbRead.query.apps.findFirst({ where: and(...conditions) });
  }

  async findByNestedSpreadConditions(id: string): Promise<unknown> {
    const idConditions = [eq(apps.id, id)];
    const conditions = [...idConditions];
    return await dbRead.query.apps.findFirst({ where: and(...conditions) });
  }

  async findScopedSpreadWithSameLocalName(orgId: string, id: string): Promise<unknown> {
    const conditions = [eq(apps.id, id), eq(apps.organization_id, orgId)];
    return await dbRead.query.apps.findFirst({ where: and(...conditions) });
  }
}
