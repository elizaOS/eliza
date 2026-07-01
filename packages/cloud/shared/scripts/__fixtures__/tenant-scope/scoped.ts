/**
 * Parse-only fixture for the tenant-scope gate (#9853 P1.6). Never executed.
 * Exercises BOTH opt-outs the checker accepts: an explicit `global-scope`
 * annotation, and a real ownership predicate in the WHERE. The checker must
 * find zero violations here.
 */
declare const dbRead: { query: { apps: { findFirst(args: unknown): Promise<unknown> } } };
declare function eq(a: unknown, b: unknown): unknown;
declare function and(...parts: unknown[]): unknown;
declare function inArray(a: unknown, b: unknown): unknown;
declare const apps: { id: unknown; organization_id: unknown };

export class ScopedFixtureRepo {
  async findByIdGlobal(id: string): Promise<unknown> {
    /* global-scope: fixture — authorization handled by the caller. */
    return await dbRead.query.apps.findFirst({ where: eq(apps.id, id) });
  }

  async findScoped(orgId: string, id: string): Promise<unknown> {
    return await dbRead.query.apps.findFirst({
      where: and(eq(apps.organization_id, orgId), eq(apps.id, id)),
    });
  }

  async findScopedIds(orgId: string, ids: string[]): Promise<unknown> {
    return await dbRead.query.apps.findFirst({
      where: and(eq(apps.organization_id, orgId), inArray(apps.id, ids)),
    });
  }

  async findScopedSpread(orgId: string, id: string): Promise<unknown> {
    const conditions = [eq(apps.id, id), eq(apps.organization_id, orgId)];
    return await dbRead.query.apps.findFirst({ where: and(...conditions) });
  }
}
