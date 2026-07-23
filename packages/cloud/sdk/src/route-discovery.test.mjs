/**
 * Verifies that Hono route discovery reports callable methods without treating
 * wildcard method-not-allowed fallbacks as public SDK operations.
 */

import { describe, expect, test } from "bun:test";
import { extractMethods } from "../scripts/route-discovery.mjs";
import { ELIZA_CLOUD_PUBLIC_ENDPOINTS } from "./public-routes.js";

const ALL_HONO_METHODS = ["DELETE", "GET", "PATCH", "POST", "PUT"];
const ROUTE_FILE = "/repo/packages/cloud/api/v1/example/route.ts";
const POST_ONLY_405_FALLBACK_ROUTES = [
  "/api/v1/apps/{id}/generate-image",
  "/api/v1/generate-image",
  "/api/v1/generate-music",
  "/api/v1/generate-sfx",
  "/api/v1/generate-video",
  "/api/v1/user/avatar",
];

async function methodsFor(source) {
  return extractMethods(source, ROUTE_FILE, "/repo");
}

describe("Hono route method discovery", () => {
  test("keeps 405-fallback routes POST-only in the generated SDK", () => {
    for (const route of POST_ONLY_405_FALLBACK_ROUTES) {
      expect(`POST ${route}` in ELIZA_CLOUD_PUBLIC_ENDPOINTS).toBe(true);
      for (const method of ["DELETE", "GET", "PATCH", "PUT"]) {
        expect(`${method} ${route}` in ELIZA_CLOUD_PUBLIC_ENDPOINTS).toBe(
          false,
        );
      }
    }
  });

  test("ignores a concise wildcard 405 fallback", async () => {
    const methods = await methodsFor(`
      const app = new Hono<AppEnv>();
      app.post("/", handler);
      app.all("*", (c) =>
        c.json({ success: false, error: "Method not allowed" }, 405),
      );
    `);

    expect(methods).toEqual(["POST"]);
  });

  test("ignores a block-bodied wildcard 405 fallback", async () => {
    const methods = await methodsFor(`
      const router = new Hono();
      router.get("/", handler);
      router.all('*', (context) => {
        // This is the transport boundary for unsupported methods.
        return context.text("Method not allowed", 405);
      });
    `);

    expect(methods).toEqual(["GET"]);
  });

  test("ignores a wildcard 405 fallback built with Response", async () => {
    const methods = await methodsFor(`
      const app = new Hono();
      app.delete("/", handler);
      app.all("*", () => new Response("Method not allowed", { status: 405 }));
    `);

    expect(methods).toEqual(["DELETE"]);
  });

  test("preserves a legitimate wildcard all-method handler", async () => {
    const methods = await methodsFor(`
      const app = new Hono();
      app.all("*", async (c) => {
        const result = await dispatch(c.req.method);
        return c.json(result);
      });
    `);

    expect(methods).toEqual(ALL_HONO_METHODS);
  });

  test("preserves a handler with both successful and 405 responses", async () => {
    const methods = await methodsFor(`
      const app = new Hono();
      app.all("*", (c) => {
        if (c.req.method === "TRACE") {
          return c.json({ error: "Method not allowed" }, 405);
        }
        return c.json({ success: true });
      });
    `);

    expect(methods).toEqual(ALL_HONO_METHODS);
  });

  test("preserves a multi-handler wildcard route with a final 405 response", async () => {
    const methods = await methodsFor(`
      const app = new Hono();
      app.all(
        "*",
        dispatchKnownMethods,
        (c) => c.json({ error: "Method not allowed" }, 405),
      );
    `);

    expect(methods).toEqual(ALL_HONO_METHODS);
  });

  test("does not confuse a nested 405 value with an HTTP status", async () => {
    const methods = await methodsFor(`
      const app = new Hono();
      app.all("*", (c) => c.json(buildDiagnostic("method", 405)));
    `);

    expect(methods).toEqual(ALL_HONO_METHODS);
  });

  test("preserves an explicit non-wildcard all-method route", async () => {
    const methods = await methodsFor(`
      const app = new Hono();
      app.all("/diagnostics", (c) => c.json({ status: 405 }));
    `);

    expect(methods).toEqual(ALL_HONO_METHODS);
  });
});
