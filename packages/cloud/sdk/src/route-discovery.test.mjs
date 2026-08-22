/**
 * Verifies that Hono route discovery reports callable methods without treating
 * wildcard method-not-allowed fallbacks as public SDK operations.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalRouteMethods,
  extractMethods,
} from "../scripts/route-discovery.mjs";
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

  test("a route file with no generator-eligible methods canonicalizes to nothing", async () => {
    // canonicalRouteMethods must skip empty-method files entirely (the
    // generator's `continue`), never synthesize a HEAD pair for them — using
    // the storage segments pins that the guard fires BEFORE HEAD synthesis,
    // so a future reordering cannot resurrect a phantom storage HEAD that
    // the audit would then read as covered.
    const canonical = await canonicalRouteMethods(
      "// route with no exported HTTP handlers\nexport const config = {};\n",
      "/repo/packages/cloud/api/v1/apis/storage/objects/[...key]/route.ts",
      "/repo",
      ["v1", "apis", "storage", "objects", "[...key]"],
    );
    expect(canonical).toBeNull();
  });

  test("the storage objects catch-all canonicalizes to the fixed route with HEAD", async () => {
    const canonical = await canonicalRouteMethods(
      'const app = new Hono();\napp.get("/", handler);\napp.put("/", handler);\napp.delete("/", handler);\n',
      "/repo/packages/cloud/api/v1/apis/storage/objects/[...key]/route.ts",
      "/repo",
      ["v1", "apis", "storage", "objects", "[...key]"],
    );
    expect(canonical).toEqual({
      route: "/api/v1/apis/storage/objects/_",
      // extractMethods returns sorted methods; the synthesized HEAD is
      // appended after them.
      methods: ["DELETE", "GET", "PUT", "HEAD"],
      fixedStorageObject: true,
    });
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

describe("generated public endpoint inventory matches the live route tree", () => {
  // The generated `file` fields are repo-root-relative (see
  // generate-public-routes.mjs: path.relative(cloudRoot, ...) where cloudRoot
  // is the repository root).
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

  test("retired phone-gateway bluebubbles routes stay out of the SDK", () => {
    // 52bf81d527 deleted packages/cloud/api/v1/phone-gateways/bluebubbles/;
    // wrappers surviving regeneration drift back in as phantom routes that
    // call endpoints that 404 in production (#24317).
    for (const key of Object.keys(ELIZA_CLOUD_PUBLIC_ENDPOINTS)) {
      expect(key.includes("phone-gateways/bluebubbles")).toBe(false);
    }
  });

  test("every generated endpoint points at a route file that still exists", () => {
    // Guards the whole drift class, not just bluebubbles: a deleted route
    // directory whose generated wrappers were never regenerated leaves
    // descriptors pointing at files that no longer exist.
    for (const [key, endpoint] of Object.entries(
      ELIZA_CLOUD_PUBLIC_ENDPOINTS,
    )) {
      const routeFile = join(repoRoot, endpoint.file);
      expect(existsSync(routeFile), `${key} -> missing ${endpoint.file}`).toBe(
        true,
      );
    }
  });
});
