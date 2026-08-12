/**
 * Drift / grep guard for the compat-route registry refactor (#12089 item 5).
 *
 * `handleCompatRouteInner` in server.ts used to enumerate ~30 compat routes as a
 * fixed, order-dependent if-chain (`if (await handleX(...)) return true`) and
 * hardwired the four plugin-local-inference route handlers inline in the
 * dispatcher body. The audit item requires that central enumeration to be an
 * ordered registry that route modules register into, with a guard proving the
 * old central if-chain / name-keyed special case is gone from the executable
 * path.
 *
 * This test reads server.ts as source text and asserts:
 *   1. the dispatcher delegates to the ordered registry via runCompatRouteChain,
 *   2. the registry const exists and is typed as an ordered entry list,
 *   3. the old inline hardwired local-inference block (the destructured
 *      getLocalInferenceRoutes() call sitting directly in the dispatcher body,
 *      guarded by nothing) is now a single registered entry, i.e. it appears
 *      inside COMPAT_ROUTE_CHAIN, not in handleCompatRouteInner,
 *   4. the dispatcher body no longer carries the long `if (await handleX...)`
 *      route if-chain (only the pre-route policy gates + the registry call).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverSrc = readFileSync(
  fileURLToPath(new URL("./server.ts", import.meta.url)),
  "utf8",
);

/** Extract the body of a top-level `function name(...) { ... }` block. */
function extractFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `signature not found: ${signature}`).toBeGreaterThanOrEqual(0);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(braceStart + 1, i);
      }
    }
  }
  throw new Error(`unterminated function body for: ${signature}`);
}

describe("compat-route registry drift guard (#12089 item 5)", () => {
  it("dispatcher delegates to the ordered registry", () => {
    const body = extractFunctionBody(
      serverSrc,
      "async function handleCompatRouteInner(",
    );
    // The dispatcher must walk the registry rather than open-code the chain.
    expect(body).toContain("runCompatRouteChain(COMPAT_ROUTE_CHAIN");
  });

  it("declares COMPAT_ROUTE_CHAIN as an ordered entry list", () => {
    expect(serverSrc).toMatch(
      /const COMPAT_ROUTE_CHAIN:\s*readonly CompatRouteChainEntry\[\]\s*=\s*\[/,
    );
  });

  it("no longer carries the inline compat-route if-chain in the dispatcher body", () => {
    const body = extractFunctionBody(
      serverSrc,
      "async function handleCompatRouteInner(",
    );
    // Count `if (await handle...` route branches directly in the dispatcher.
    // The old if-chain had ~20 of them; the registry-driven dispatcher should
    // have zero (routes live in COMPAT_ROUTE_CHAIN entries instead). We allow a
    // small budget of 2 in case an unrelated pre-route gate uses the pattern.
    const matches = body.match(/if\s*\(await handle[A-Z]\w+CompatRoute/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(2);
    // Specifically, the terminal db-rows handler is the only remaining
    // hardcoded route call in the dispatcher body, and it is a fallthrough
    // (return), not an if-branch.
    expect(body).toContain("return handleDatabaseRowsCompatRoute(");
  });

  it("local-inference handlers are a registered entry, not an inline dispatcher block", () => {
    const dispatcherBody = extractFunctionBody(
      serverSrc,
      "async function handleCompatRouteInner(",
    );
    // The old hardwired block destructured all four handlers off
    // getLocalInferenceRoutes() directly inside the dispatcher. That call must
    // no longer live in the dispatcher body.
    expect(dispatcherBody).not.toContain("getLocalInferenceRoutes()");

    // Instead it lives inside the registry, under a "local-inference" entry.
    const chainStart = serverSrc.indexOf("const COMPAT_ROUTE_CHAIN");
    expect(chainStart).toBeGreaterThanOrEqual(0);
    const chainRegion = serverSrc.slice(chainStart);
    expect(chainRegion).toContain('id: "local-inference"');
    expect(chainRegion).toContain("getLocalInferenceRoutes()");
    // Plugin compat guards cannot resolve app-core's DB-backed browser cookie.
    // The host gate therefore hands its completed authorization to all four
    // handlers on a fresh per-request state object (never shared mutable state).
    expect(chainRegion).toContain("requestAuthorizedByHost: true as const");
    expect(chainRegion).toContain("const authorizedState = {");
    // All four local-inference sub-handlers still dispatch, preserving behavior.
    for (const fn of [
      "handleLocalInferenceCompatRoutes",
      "handleLocalInferenceAsrRoute",
      "handleLocalInferenceTtsRoute",
      "handleLiveDiarizationRoute",
    ]) {
      expect(chainRegion, `${fn} missing from registry`).toContain(fn);
      expect(chainRegion, `${fn} must receive the host auth handoff`).toMatch(
        new RegExp(`${fn}\\(req, res, authorizedState\\)`),
      );
    }
  });

  it("preserves the legacy dispatch ORDER of the migrated compat routes", () => {
    // The registry array order IS the dispatch order. Pin the exact sequence
    // that the old top-to-bottom if-chain produced so a re-order is caught.
    const chainStart = serverSrc.indexOf("const COMPAT_ROUTE_CHAIN");
    const chainRegion = serverSrc.slice(chainStart);
    const ids = [...chainRegion.matchAll(/\bid:\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(ids).toEqual([
      "runtime-mode",
      "i18n-locale",
      "cloud-compat-proxy",
      "cloud-billing",
      "dev-compat",
      "cloud-pair",
      "auth-bootstrap",
      "auth-session",
      "auth-pairing",
      "embed-auth",
      "sensitive-request",
      "account-pool-status",
      "credential-tunnel",
      "background-tasks",
      "internal-wake",
      "local-inference",
      "automations",
      "secrets",
      "drop-status",
      "agent-reset",
      "plugins",
      "catalog",
      "first-run",
      "plugin-ui-spec",
      "agents",
      "config",
    ]);
  });
});
