/**
 * request-logger.ts — drop-in replacement for hono's `logger()` that never
 * writes the request QUERY STRING to logs.
 *
 * SEC-015: hono's global logger records `url.slice(url.indexOf("/", 8))` —
 * the full path INCLUDING the query string. Live one-time credentials flow
 * through query strings on GET auth callbacks mounted in this app
 * (`GET /auth/callback/email?token=…`, `GET /auth/oauth/:provider/callback
 * ?code=…&state=…`), so anyone with log access (aggregators, container logs)
 * could replay an unconsumed magic-link token to mint a session. This logger
 * keeps hono's output format but logs only the path (`getPath` strips the
 * query), so credentials in query strings never reach stdout.
 */

import { logger } from "@elizaos/logger";
import { createMiddleware } from "hono/factory";
import { getPath } from "hono/utils/url";

const humanize = (times: string[]) => {
  const [delimiter, separator] = [",", "."];
  const orderTimes = times.map((v) =>
    v.replace(/(\d)(?=(\d\d\d)+(?!\d))/g, `$1${delimiter}`),
  );
  return orderTimes.join(separator);
};

const time = (start: number) => {
  const delta = Date.now() - start;
  return humanize([delta < 1e3 ? `${delta}ms` : `${Math.round(delta / 1e3)}s`]);
};

function log(
  fn: (message: string) => void,
  prefix: string,
  method: string,
  path: string,
) {
  fn(`${prefix} ${method} ${path}`);
}

function logResponse(
  fn: (message: string) => void,
  prefix: string,
  method: string,
  path: string,
  status: number,
  elapsed: string,
) {
  fn(`${prefix} ${method} ${path} ${status} ${elapsed}`);
}

export const requestLogger = (
  fn: (message: string) => void = (message) =>
    logger.info(`[Login] ${message}`),
) =>
  createMiddleware(async (c, next) => {
    const { method } = c.req;
    // getPath returns the request path WITHOUT the query string — the whole
    // point of this middleware (SEC-015).
    const path = getPath(c.req.raw);
    log(fn, "<--", method, path);
    const start = Date.now();
    await next();
    logResponse(fn, "-->", method, path, c.res.status, time(start));
  });
