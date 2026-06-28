import { escapeLiteral, type Pool as PgPool, type PoolClient } from "pg";

type PgConnectCallback = (
  err: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

interface LocalQueryOptions {
  simpleQueryMode?: boolean;
}

const localQueryTargetWrapped = new WeakSet<object>();
// Process-unique prefix ensures prepared statement names never collide across
// restarts or parallel processes against the same PGlite TCP server.
const _localPgPrefix = `lpg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
let _localPgSeq = 0;

function formatPgArrayItem(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatPgArray(value: readonly unknown[]): string {
  return `{${value.map(formatPgArrayItem).join(",")}}`;
}

function bytesToHex(value: Uint8Array): string {
  let hex = "";
  for (const byte of value) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function formatPgParam(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : escapeLiteral(String(value));
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "string") {
    return escapeLiteral(value);
  }
  if (value instanceof Date) {
    return escapeLiteral(value.toISOString());
  }
  if (value instanceof Uint8Array) {
    return `decode('${bytesToHex(value)}', 'hex')`;
  }
  if (Array.isArray(value)) {
    return escapeLiteral(formatPgArray(value));
  }
  return escapeLiteral(JSON.stringify(value));
}

function copyQuotedSql(text: string, start: number, quote: "'" | '"'): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === quote) {
      if (text[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

function copyLineComment(text: string, start: number): number {
  const end = text.indexOf("\n", start + 2);
  return end === -1 ? text.length : end;
}

function copyBlockComment(text: string, start: number): number {
  const end = text.indexOf("*/", start + 2);
  return end === -1 ? text.length : end + 2;
}

function inlinePgParams(text: string, params: readonly unknown[]): string {
  let output = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "'" || char === '"') {
      const end = copyQuotedSql(text, index, char);
      output += text.slice(index, end);
      index = end;
      continue;
    }

    if (char === "-" && next === "-") {
      const end = copyLineComment(text, index);
      output += text.slice(index, end);
      index = end;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = copyBlockComment(text, index);
      output += text.slice(index, end);
      index = end;
      continue;
    }

    if (char === "$" && next && next >= "0" && next <= "9") {
      let end = index + 2;
      while (end < text.length && text[end] >= "0" && text[end] <= "9") {
        end += 1;
      }
      const paramIndex = Number.parseInt(text.slice(index + 1, end), 10) - 1;
      if (paramIndex >= 0 && paramIndex < params.length) {
        output += formatPgParam(params[paramIndex]);
        index = end;
        continue;
      }
    }

    output += char;
    index += 1;
  }

  return output;
}

export function wrapLocalQueryTarget(
  target: PgPool | PoolClient,
  options: LocalQueryOptions = {},
): void {
  if (localQueryTargetWrapped.has(target)) {
    return;
  }
  localQueryTargetWrapped.add(target);

  const originalQuery = target.query.bind(target) as (
    config: unknown,
    values?: unknown,
    callback?: unknown,
  ) => unknown;

  target.query = ((config: unknown, values?: unknown, callback?: unknown) => {
    if (typeof config === "string" && Array.isArray(values) && values.length > 0) {
      if (options.simpleQueryMode) {
        return originalQuery(inlinePgParams(config, values), callback as never);
      }
      _localPgSeq += 1;
      const name = `${_localPgPrefix}_${_localPgSeq.toString(36)}`;
      return originalQuery({ text: config, values, name, portal: name }, callback as never);
    }

    if (config && typeof config === "object" && "text" in config) {
      const queryConfig = config as Record<string, unknown>;
      const queryCallback = typeof values === "function" ? values : callback;
      const params = Array.isArray(values)
        ? values
        : Array.isArray(queryConfig.values)
          ? (queryConfig.values as unknown[])
          : undefined;
      if (params && params.length > 0 && !queryConfig.name) {
        if (options.simpleQueryMode) {
          const {
            name: _name,
            portal: _portal,
            queryMode: _queryMode,
            values: _values,
            ...simpleConfig
          } = queryConfig;
          return originalQuery(
            { ...simpleConfig, text: inlinePgParams(String(queryConfig.text), params) },
            queryCallback as never,
          );
        }

        _localPgSeq += 1;
        const name = `${_localPgPrefix}_${_localPgSeq.toString(36)}`;
        return originalQuery(
          { ...queryConfig, values: params, name, portal: name },
          queryCallback as never,
        );
      }
    }

    return originalQuery(config as never, values as never, callback as never);
  }) as typeof target.query;
}

export function disableLocalPreparedStatements(
  pool: PgPool,
  options: LocalQueryOptions = {},
): void {
  wrapLocalQueryTarget(pool, options);

  const originalConnect = pool.connect.bind(pool);
  pool.connect = ((callback?: PgConnectCallback) => {
    if (callback) {
      return originalConnect((err, client, done) => {
        if (client) {
          wrapLocalQueryTarget(client, options);
        }
        callback(err, client, done);
      });
    }

    return originalConnect().then((client) => {
      wrapLocalQueryTarget(client, options);
      return client;
    });
  }) as typeof pool.connect;
}
