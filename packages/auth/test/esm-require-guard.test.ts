/**
 * `packages/auth` is ESM (`package.json` -> `"type": "module"`), so a bare
 * `require(...)` is a free variable on the real Node runtime and throws
 * `ReferenceError: require is not defined` the first time the path runs. bun and
 * the vitest module runner both define `require`, so the suite cannot observe
 * that crash — which is how `auth-lifecycle.ts` shipped three such fallbacks
 * (the same class that also hit `server/wallet/hd-wallet.ts`).
 *
 * `MemoryBackend` is already a top-level static import in this file, so those
 * calls bought nothing. This pins the file require-free.
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const LIFECYCLE_SOURCE = new URL(
  "../src/server/api/services/auth-lifecycle.ts",
  import.meta.url,
);

it("keeps the auth lifecycle stores free of bare require() calls", () => {
  const source = readFileSync(LIFECYCLE_SOURCE, "utf8");
  const bareRequire = source.match(/(^|[^.\w$])require\s*\(/g) ?? [];
  expect(
    bareRequire,
    "auth-lifecycle.ts is ESM; a bare require() throws under Node. Use a static import.",
  ).toEqual([]);
});
