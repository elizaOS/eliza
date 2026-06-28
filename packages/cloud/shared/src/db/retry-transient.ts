/**
 * Bounded retry for transient database connection failures.
 *
 * Remote Postgres reached from a Cloudflare Worker (via Hyperdrive / a managed
 * TCP proxy) can drop a connection mid-query or refuse a fresh handshake under
 * load — surfacing as `Connection terminated unexpectedly`, an SSL handshake
 * EOF, or a connection-class SQLSTATE. On the auth hot path a single such blip
 * would otherwise turn a valid session into a 500. Retrying ONLY genuinely
 * transient connection errors (never query/constraint errors) with a small
 * backoff lets these recover; a sustained outage still surfaces the real error
 * after the attempts are exhausted.
 *
 * @module db/retry-transient
 */

/** Connection-class SQLSTATEs (class 08) + admin-shutdown / overload codes. */
const TRANSIENT_PG_CODES = new Set([
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "08007", // transaction_resolution_unknown
  "08P01", // protocol_violation
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
]);

/** Node socket-level error codes that mean "try again". */
const TRANSIENT_NODE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

const TRANSIENT_MESSAGE_RE =
  /connection terminated|could not accept ssl connection|connection (reset|closed|refused|timeout)|terminating connection|server closed the connection|socket hang ?up|read econnreset|timeout expired/i;

/**
 * Whether an error represents a transient DB *connection* failure (safe to
 * retry), as opposed to a query/constraint/logic error (which must not retry).
 * Walks `cause` so wrapped driver errors are still classified.
 */
export function isTransientDbError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (
    typeof code === "string" &&
    (TRANSIENT_PG_CODES.has(code) || TRANSIENT_NODE_CODES.has(code))
  ) {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && TRANSIENT_MESSAGE_RE.test(message)) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause && cause !== error ? isTransientDbError(cause) : false;
}

export interface RetryTransientOptions {
  /** Total attempts including the first call. Default 3. */
  attempts?: number;
  /** Base backoff in ms (doubles per attempt). Default 50. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 500. */
  maxDelayMs?: number;
  /** Sleeper override for tests (defaults to setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying only on transient DB connection errors with exponential
 * backoff + jitter. Non-transient errors are rethrown immediately; the last
 * error is rethrown once attempts are exhausted.
 */
export async function retryOnTransientDbError<T>(
  fn: () => Promise<T>,
  options: RetryTransientOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 50;
  const maxDelayMs = options.maxDelayMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientDbError(error)) {
        throw error;
      }
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.floor(backoff * 0.25 * Math.random());
      await sleep(backoff + jitter);
    }
  }
  throw lastError;
}
