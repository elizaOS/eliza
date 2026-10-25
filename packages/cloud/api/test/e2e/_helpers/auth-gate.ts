/**
 * Preserve failure responses from strict unauthenticated e2e checks so Worker
 * transport errors can be distinguished from application auth rejections.
 */

import { expect } from "bun:test";

/** Require the exact auth rejection and retain evidence for every other status. */
export async function expectAuthGate(
  response: Response,
  path: string,
): Promise<void> {
  if (response.status !== 401) {
    const headers = Object.fromEntries(
      [
        "content-type",
        "x-eliza-trace-id",
        "x-request-id",
        "cf-ray",
        "server-timing",
      ]
        .map((name) => [name, response.headers.get(name)])
        .filter(([, value]) => value !== null),
    );
    throw new Error(
      `Expected 401 from unauthenticated ${path}, got ${response.status}; ` +
        JSON.stringify({ headers, body: await response.clone().text() }),
    );
  }
  expect(response.status).toBe(401);
}
