/**
 * Guards the app-core API wrapper's bind-first contract. OS credential-store
 * reads can prompt or block at the native boundary, so runtime boot owns them
 * after the listener is live instead of `startApiServer` awaiting them.
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
  it("does not read the OS credential store before binding", () => {
    const body = extractStartApiServerBody(serverSource);

    expect(body).toContain("await upstreamStartApiServer({");
    expect(body).not.toContain("hydrateWalletKeysFromNodePlatformSecureStore");
  });
});
