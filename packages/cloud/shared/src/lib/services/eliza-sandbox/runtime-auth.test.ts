/** Exercises sandbox runtime auth contracts with deterministic external-boundary fixtures. Real durable authority is covered separately by the PGlite suites. */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
function restoreWebSocketPair() {
  if (originalWebSocketPair)
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
  else Reflect.deleteProperty(globalThis, "WebSocketPair");
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreWebSocketPair();
});
describe("replacement runtime authentication contract", () => {
  test("keeps /api/status protected while only GET /api/health bypasses authentication", () => {
    const agentApiDirectory = new URL("../../../../../../agent/src/api/", import.meta.url);
    const routeClassifierSource = readFileSync(
      new URL("static-file-server.ts", agentApiDirectory),
      "utf8",
    );
    const serverSource = readFileSync(new URL("server.ts", agentApiDirectory), "utf8");

    // Both endpoints enter the normal protected /api namespace. The agent
    // server then exempts only the public liveness probe; rollout identity and
    // startup checks deliberately use /api/status so a missing or rejected
    // agent token fails before the public readiness probe can pass.
    expect(routeClassifierSource).toMatch(
      /export function isAuthProtectedRoute\(pathname: string\): boolean \{[\s\S]*pathname\.startsWith\("\/api\/"\)/,
    );
    expect(serverSource).toContain(
      'const isHealthEndpoint = method === "GET" && pathname === "/api/health";',
    );

    const authGateStart = serverSource.indexOf(
      'method !== "OPTIONS" &&\n    isAuthProtectedPath &&',
    );
    const authGateEnd = serverSource.indexOf(
      'json(res, { error: "Unauthorized" }, 401);',
      authGateStart,
    );
    expect(authGateStart).toBeGreaterThan(-1);
    expect(authGateEnd).toBeGreaterThan(authGateStart);

    const authGate = serverSource.slice(authGateStart, authGateEnd);
    expect(authGate).toContain("!isHealthEndpoint");
    expect(authGate).not.toContain('"/api/status"');
    expect(authGate).not.toContain("isStatusEndpoint");
  });
});
