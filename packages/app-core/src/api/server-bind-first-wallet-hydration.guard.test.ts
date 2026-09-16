/**
 * Guards the app-core API wrapper's bind-first contract. OS credential-store
 * reads can prompt or block at the native boundary, so `startApiServer`
 * schedules them after the listener is live and returns an observable promise.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const serverSource = readFileSync(
  new URL("./server.ts", import.meta.url),
  "utf8",
);

function extractStartApiServerBody(source: string): string {
  const signature = "export async function startApiServer(";
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("{", start);
  expect(bodyStart).toBeGreaterThan(start);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error("startApiServer body is not balanced");
}

describe("app-core API bind-first wallet hydration", () => {
  it("binds before scheduling an observable OS credential-store read", () => {
    const body = extractStartApiServerBody(serverSource);
    const bind = body.indexOf("await upstreamStartApiServer({");
    const hydrate = body.indexOf(
      "hydrateWalletKeysFromNodePlatformSecureStore()",
    );

    expect(bind).toBeGreaterThanOrEqual(0);
    expect(hydrate).toBeGreaterThan(bind);
    expect(body).toContain(
      "return Object.assign(server, { walletHydration });",
    );
  });
});
