/** Adapts parameterized auth-store SQL and atomic transactions to the embedded database. */
import { ElizaError } from "@elizaos/core/errors";
import { sql } from "drizzle-orm";
import {
  getDb,
  type getSql,
  hasTenantTransactionDatabase,
  isEmbeddedDatabase,
} from "../../db/src/client";

function parameterizedStatement(strings: TemplateStringsArray): string {
  return strings.reduce(
    (query, segment, index) =>
      query + (index === 0 ? "" : `$${index}`) + segment,
    "",
  );
}

function resultRows<Row>(result: Row[] | { rows: Row[] }): Row[] {
  return Array.isArray(result) ? result : result.rows;
}

function queryTag(database: () => Pick<ReturnType<typeof getDb>, "execute">) {
  return async <Rows extends Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): Promise<Rows[number][]> => {
    const statement = sql.empty();
    strings.forEach((segment, index) => {
      if (index > 0) statement.append(sql`${values[index - 1]}`);
      statement.append(sql.raw(segment));
    });
    return resultRows(await database().execute<Rows[number]>(statement));
  };
}

function postgresQueryTag(client: Pick<ReturnType<typeof getSql>, "unsafe">) {
  return async <Rows extends Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): Promise<Rows[number][]> => {
    return await client.unsafe<Rows>(parameterizedStatement(strings), values);
  };
}

export function createPostgresAuthSql(
  client: ReturnType<typeof getSql>,
): ReturnType<typeof createDatabaseAuthSql> {
  const query = postgresQueryTag(client);
  type Callback = (transaction: typeof query) => Promise<void>;
  async function begin(callback: Callback): Promise<void>;
  async function begin(
    options: "isolation level serializable",
    callback: Callback,
  ): Promise<void>;
  async function begin(
    options: "isolation level serializable" | Callback,
    callback?: Callback,
  ): Promise<void> {
    const run = typeof options === "function" ? options : callback;
    if (!run) throw new TypeError("Auth transaction callback is required");
    await client.begin(
      typeof options === "string" ? options : "",
      async (transaction) => {
        await run(postgresQueryTag(transaction));
      },
    );
  }
  return Object.assign(query, { begin });
}

export function createDatabaseAuthSql() {
  const query = queryTag(getDb);
  type Callback = (transaction: typeof query) => Promise<void>;
  async function begin(callback: Callback): Promise<void>;
  async function begin(
    options: "isolation level serializable",
    callback: Callback,
  ): Promise<void>;
  async function begin(
    options: "isolation level serializable" | Callback,
    callback?: Callback,
  ): Promise<void> {
    const run = typeof options === "function" ? options : callback;
    if (!run) throw new TypeError("Auth transaction callback is required");
    if (
      typeof options === "string" &&
      !isEmbeddedDatabase() &&
      hasTenantTransactionDatabase()
    ) {
      const [isolation] = await query<
        Array<{ level: string }>
      >`SELECT current_setting('transaction_isolation') AS level`;
      if (isolation.level !== "serializable") {
        throw new ElizaError(
          "Atomic auth publication requires a serializable transaction",
          { code: "LOGIN_AUTH_ISOLATION_REQUIRED" },
        );
      }
    }
    // getDb resolves the current identity transaction, so auth state cannot
    // queue behind the same request's transaction on PGlite's single connection.
    await getDb().transaction(
      async (transaction) => {
        await run(queryTag(() => transaction));
      },
      typeof options === "string"
        ? { isolationLevel: "serializable" }
        : undefined,
    );
  }
  return Object.assign(query, { begin });
}
