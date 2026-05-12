/**
 * Router contract checks for the Hono codegen adapter.
 *
 * This intentionally tests the generated mount table without importing the
 * real route modules, so it can run without database or Cloudflare bindings.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { collectRouteEntries, compareMountPaths } from "../src/_generate-router.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");
const ROUTER = join(API_ROOT, "src", "_router.generated.ts");

function generatedRoutes() {
  const routerSrc = readFileSync(ROUTER, "utf8");
  return [...routerSrc.matchAll(/app\.route\(\s*"([^"]+)"/g)].map((m) => m[1]);
}

function route(label) {
  const app = new Hono();
  app.get("/", (c) => c.text(label));
  app.post("/", (c) => c.text(`${label}:post`));
  return app;
}

async function responseText(app, path, method = "GET") {
  const response = await app.request(path, { method });
  return { status: response.status, text: await response.text() };
}

function assertBefore(routes, first, second) {
  const firstIndex = routes.indexOf(first);
  const secondIndex = routes.indexOf(second);
  assert.notEqual(firstIndex, -1, `${first} must be mounted`);
  assert.notEqual(secondIndex, -1, `${second} must be mounted`);
  assert.ok(firstIndex < secondIndex, `${first} must be mounted before ${second}`);
}

const { entries } = await collectRouteEntries(API_ROOT);
const expectedRoutes = entries.map((entry) => entry.path);
const actualRoutes = generatedRoutes();

assert.deepEqual(actualRoutes, expectedRoutes, "generated router must match current route tree");
assert.ok(actualRoutes.includes("/api/.well-known/jwks.json"), ".well-known route must be mounted");
assert.ok(
  actualRoutes.includes("/api/v1/proxy/birdeye/:*{.+}"),
  "catch-all routes must mount as Hono regex wildcard params",
);
assert.ok(
  !actualRoutes.some((path) => path.endsWith("/*")),
  "generated routes must not use bare *",
);

assertBefore(actualRoutes, "/api/invoices/list", "/api/invoices/:id");
assertBefore(actualRoutes, "/api/my-agents/characters/avatar", "/api/my-agents/characters/:id");
assertBefore(actualRoutes, "/api/v1/agents/by-token", "/api/v1/agents/:agentId");
assertBefore(actualRoutes, "/api/v1/apps/check-name", "/api/v1/apps/:id");
assertBefore(actualRoutes, "/api/v1/oauth/callback", "/api/v1/oauth/:platform/callback");

const ordered = [
  { path: "/api/v1/apps/:id", app: route("dynamic") },
  { path: "/api/v1/apps/check-name", app: route("static") },
].sort(compareMountPaths);
const orderingApp = new Hono({ strict: false });
for (const item of ordered) orderingApp.route(item.path, item.app);

assert.deepEqual(await responseText(orderingApp, "/api/v1/apps/check-name"), {
  status: 200,
  text: "static",
});
assert.deepEqual(await responseText(orderingApp, "/api/v1/apps/abc"), {
  status: 200,
  text: "dynamic",
});
assert.deepEqual(await responseText(orderingApp, "/api/v1/apps/abc/"), {
  status: 200,
  text: "dynamic",
});
assert.deepEqual(await responseText(orderingApp, "/api/v1/apps/abc", "POST"), {
  status: 200,
  text: "dynamic:post",
});

const catchAllApp = new Hono({ strict: false });
const catchAllRoute = new Hono();
catchAllRoute.get("/*", (c) => c.text(c.req.param("*") ?? "missing"));
catchAllApp.route("/api/v1/proxy/birdeye/:*{.+}", catchAllRoute);

assert.deepEqual(await responseText(catchAllApp, "/api/v1/proxy/birdeye/defi/price"), {
  status: 200,
  text: "defi/price",
});
assert.equal((await catchAllApp.request("/api/v1/proxy/birdeye")).status, 404);

console.log(
  JSON.stringify({
    mountedRoutes: actualRoutes.length,
    checked: [
      "inventory parity",
      "static-before-dynamic ordering",
      "named catch-all conversion",
      "method dispatch",
      "trailing slash compatibility",
    ],
  }),
);
