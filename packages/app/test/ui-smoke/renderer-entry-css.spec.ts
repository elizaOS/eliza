/**
 * Builds the shipped renderer selector with Vite and exercises its lazy CSS in
 * Chromium. Tiny renderer fixtures isolate bundler behavior while the routing
 * policy and boot-failure boundary remain the production implementations.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build, normalizePath } from "vite";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const entryPath = path.join(appRoot, "src/entry.ts");
const renderers = ["marketing-home-entry", "public-web-entry", "main"] as const;
let fixtureRoot: string;

test.beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "eliza-renderer-css-"));
  await writeFile(
    path.join(fixtureRoot, "index.html"),
    '<div id="root"></div><script type="module" src="/entry.ts"></script>',
  );
  for (const [index, renderer] of renderers.entries()) {
    await writeFile(
      path.join(fixtureRoot, `${renderer}.ts`),
      `
      import "./${renderer}.css";
      if (new URLSearchParams(location.search).has("fail")) throw new Error("renderer failed");
      document.querySelector("#root").textContent = ${JSON.stringify(renderer)};
      window.executedRenderers = [...(window.executedRenderers || []), ${JSON.stringify(renderer)}];
    `,
    );
    await writeFile(
      path.join(fixtureRoot, `${renderer}.css`),
      `:root { --${renderer}-loaded: loaded; } #root { padding-left: ${(index + 1) * 11}px; }`,
    );
  }
  await build({
    configFile: false,
    root: fixtureRoot,
    logLevel: "silent",
    plugins: [
      {
        name: "renderer-fixtures",
        enforce: "pre",
        resolveId(source, importer) {
          if (source === "/entry.ts") return entryPath;
          if (
            importer !== undefined &&
            normalizePath(importer) === normalizePath(entryPath) &&
            renderers.some((name) => source === `./${name}`)
          )
            return path.join(fixtureRoot, `${source.slice(2)}.ts`);
        },
      },
    ],
    resolve: {
      alias: {
        "@elizaos/shared/elizacloud/domain-contract": path.join(
          appRoot,
          "../shared/src/elizacloud/domain-contract.ts",
        ),
      },
    },
    define: {
      __ELIZA_WEB_SHELL__: "true",
      __ELIZA_PUBLIC_WEB_ENTRY__: "true",
      __ELIZA_CHAT_UI_HARNESS__: "false",
    },
    build: { outDir: "dist", emptyOutDir: true, modulePreload: false },
  });
});

test.afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.route("https://eliza.app/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const isAsset = pathname.startsWith("/assets/");
    const file = path.join(
      fixtureRoot,
      "dist",
      isAsset ? pathname.slice(1) : "index.html",
    );
    await route.fulfill({
      body: await readFile(file),
      contentType: file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".js")
          ? "text/javascript"
          : "text/html",
    });
  });
});

for (const [index, [route, renderer]] of (
  [
    ["/", "marketing-home-entry"],
    ["/login", "public-web-entry"],
    ["/agent", "main"],
  ] as const
).entries()) {
  test(`${renderer} loads its own CSS without evaluating other renderers`, async ({
    page,
  }) => {
    await page.goto(`https://eliza.app${route}`);
    await expect(page.locator("#root")).toHaveText(renderer);
    await expect(page.locator("#root")).toHaveCSS(
      "padding-left",
      `${(index + 1) * 11}px`,
    );
    expect(
      await page.evaluate(
        () =>
          (window as Window & { executedRenderers?: string[] })
            .executedRenderers,
      ),
    ).toEqual([renderer]);
    const styles = await page.evaluate(
      (names) =>
        names.map((name) =>
          getComputedStyle(document.documentElement)
            .getPropertyValue(`--${name}-loaded`)
            .trim(),
        ),
      renderers,
    );
    expect(styles).toEqual(
      renderers.map((name) => (name === renderer ? "loaded" : "")),
    );
  });
}

test("a selected renderer failure reaches the production reload boundary", async ({
  page,
}) => {
  await page.goto("https://eliza.app/?fail");
  await expect(page.getByTestId("boot-failure")).toContainText(
    "Couldn't start the app.",
  );
  await expect(
    page.getByRole("button", { name: "Reload", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { executedRenderers?: string[] }).executedRenderers,
    ),
  ).toBeUndefined();
});
