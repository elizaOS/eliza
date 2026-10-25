/**
 * Builds a lazy route with real Vite CSS preloading and the production cloud
 * error boundary. A removed deployment asset must trigger one document reload
 * and render the available stylesheet, with persistent failures bounded by the
 * same recovery cooldown.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "vite";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const origin = "https://eliza.app";
let fixtureRoot: string;

test.beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "eliza-lazy-css-"));
  await writeFile(
    path.join(fixtureRoot, "index.html"),
    '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/entry.tsx"></script>',
  );
  await writeFile(
    path.join(fixtureRoot, "entry.tsx"),
    `import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { CloudRouteErrorBoundary } from ${JSON.stringify(path.join(repoRoot, "packages/ui/src/cloud/shell/CloudRouteErrorBoundary.tsx"))};
const Page = lazy(() => import("./page"));
createRoot(document.getElementById("root")).render(
  <CloudRouteErrorBoundary routePath="login">
    <Suspense fallback={<p>Loading</p>}><Page /></Suspense>
  </CloudRouteErrorBoundary>
);`,
  );
  await writeFile(
    path.join(fixtureRoot, "page.tsx"),
    'import React from "react"; import "./page.css"; export default function Page() { return <h1>Recovered login</h1>; }',
  );
  for (const [version, color] of [
    ["old", "rgb(111, 22, 33)"],
    ["current", "rgb(12, 34, 56)"],
  ]) {
    await writeFile(
      path.join(fixtureRoot, "page.css"),
      `h1 { color: ${color}; }`,
    );
    await build({
      root: fixtureRoot,
      configFile: false,
      logLevel: "silent",
      esbuild: { jsx: "automatic" },
      resolve: {
        alias: {
          react: path.join(repoRoot, "node_modules/react"),
          "react-dom": path.join(repoRoot, "node_modules/react-dom"),
        },
      },
      build: { outDir: version, modulePreload: false },
    });
  }
});

test.afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

for (const mode of ["recover", "persistent", "getItem", "setItem"] as const) {
  const persistentFailure = mode === "persistent";
  const storageDenied = mode === "getItem" || mode === "setItem";
  test(
    storageDenied
      ? `unavailable sessionStorage.${mode} leaves CSS recovery to manual Reload`
      : persistentFailure
        ? "a persistently missing lazy stylesheet stops auto-reloading and offers manual recovery"
        : "a missing lazy stylesheet reloads once and renders the recovered route with its CSS",
    async ({ page }) => {
      let documents = 0;
      let cssRequests = 0;
      await page.route(`${origin}/**`, async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.endsWith(".css")) {
          cssRequests += 1;
          if (persistentFailure || cssRequests === 1) {
            await route.fulfill({ status: 404, body: "Asset removed" });
            return;
          }
        }
        const file = pathname.startsWith("/assets/")
          ? pathname.slice(1)
          : "index.html";
        if (route.request().isNavigationRequest()) documents += 1;
        // The first document has the retired deployment's chunk graph.
        // Reload receives a new shell and genuinely different hashed CSS.
        const version = documents <= 1 ? "old" : "current";
        await route.fulfill({
          body: await readFile(path.join(fixtureRoot, version, file)),
          contentType: file.endsWith(".css")
            ? "text/css"
            : file.endsWith(".js")
              ? "text/javascript"
              : "text/html",
        });
      });

      if (storageDenied) {
        await page.addInitScript((operation) => {
          Object.defineProperty(Storage.prototype, operation, {
            configurable: true,
            value() {
              throw new DOMException("Storage denied", "SecurityError");
            },
          });
        }, mode);
      }
      await page.goto(`${origin}/login`);
      if (storageDenied) {
        await expect(
          page.getByTestId("cloud-route-error-reload"),
        ).toBeVisible();
        expect(documents).toBe(1);
        expect(cssRequests).toBe(1);
        await page.getByTestId("cloud-route-error-reload").click();
      }
      if (persistentFailure) {
        await expect(
          page.getByTestId("cloud-route-error-reload"),
        ).toBeVisible();
        await expect(
          page.getByTestId("cloud-route-error-fallback"),
        ).toContainText("Unable to preload CSS for");
        await expect(
          page.getByRole("heading", { name: "Recovered login" }),
        ).toHaveCount(0);
        await expect.poll(() => cssRequests).toBe(2);
        expect(documents).toBe(2);
        await page.getByTestId("cloud-route-error-reload").click();
        await expect.poll(() => cssRequests).toBe(3);
        await expect(
          page.getByTestId("cloud-route-error-reload"),
        ).toBeVisible();
        expect(documents).toBe(3);
      } else {
        const recovered = page.getByRole("heading", {
          name: "Recovered login",
        });
        await expect(recovered).toBeVisible();
        await expect(recovered).toHaveCSS("color", "rgb(12, 34, 56)");
        await expect(
          page.getByTestId("cloud-route-error-fallback"),
        ).toHaveCount(0);
        expect(documents).toBe(2);
        expect(cssRequests).toBe(2);
      }
    },
  );
}
