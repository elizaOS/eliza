/**
 * Minimal stand-in for `@elizaos/app-core`'s route-response helpers, used by
 * the route-level tests in this package so they don't pull in the full
 * app-core dependency tree.
 */
export const client = {};

export function sendJson(
  res: {
    writeHead?: (status: number, headers?: Record<string, string>) => void;
    end?: (body?: string) => void;
  },
  status: number,
  body: unknown,
): void {
  res.writeHead?.(status, { "content-type": "application/json" });
  res.end?.(JSON.stringify(body));
}

export function sendJsonError(
  res: {
    writeHead?: (status: number, headers?: Record<string, string>) => void;
    end?: (body?: string) => void;
  },
  status: number,
  message: string,
): void {
  sendJson(res, status, { error: message });
}
