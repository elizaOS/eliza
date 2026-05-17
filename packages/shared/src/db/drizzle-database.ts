/**
 * Canonical `DrizzleDatabase` type used by app-core, plugin-sql, and any
 * downstream package that holds a reference to the runtime Drizzle handle.
 *
 * `plugin-sql` constructs both `NodePgDatabase` and `PgliteDatabase`, which
 * both extend `PgDatabase<PgQueryResultHKT, ...>`. App-core only stores the
 * value and passes it to drizzle query builders, so the structural
 * `PgDatabase` type is sufficient and avoids reverse-importing plugin-sql or
 * pulling Postgres driver types into the shared workspace.
 */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export type DrizzleDatabase = PgDatabase<PgQueryResultHKT>;
