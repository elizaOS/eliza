import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const TINYPLACE_PACKAGE_NAME = "@tinyhumansai/plugin-tinyplace";
const HOST_EXTERNAL_SPECIFIERS = [
  "react",
  "react/jsx-runtime",
  "@elizaos/ui/agent-surface",
] as const;

function resolveTinyPlacePluginDir(): string | null {
  const raw = process.env.TINYPLACE_ELIZAOS_PLUGIN_DIR?.trim();
  if (!raw) return null;
  const absolute = path.resolve(raw);
  const candidates = [absolute, path.join(absolute, "sdk", "plugin-elizaos")];
  for (const candidate of candidates) {
    const packageJsonPath = path.join(candidate, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        name?: unknown;
      };
      if (pkg.name === TINYPLACE_PACKAGE_NAME) return candidate;
    } catch {}
  }
  return null;
}

const tinyPlacePluginDir = resolveTinyPlacePluginDir();
const tinyPlaceBundlePath = tinyPlacePluginDir
  ? path.join(tinyPlacePluginDir, "dist", "views", "bundle.js")
  : null;

function convertNamedImportsToDestructuring(namedImports: string): string {
  return namedImports
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/\s+as\s+/u, ": "))
    .join(", ");
}

function splitTopLevelImportClause(importClause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < importClause.length; index += 1) {
    const char = importClause[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      parts.push(importClause.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(importClause.slice(start).trim());
  return parts.filter(Boolean);
}

function appendHostExternalBinding(
  lines: string[],
  moduleVar: string,
  binding: string,
): void {
  const namedMatch = binding.match(/^\{([\s\S]*)\}$/u);
  if (namedMatch) {
    lines.push(
      `const { ${convertNamedImportsToDestructuring(namedMatch[1])} } = ${moduleVar};`,
    );
    return;
  }

  const namespaceMatch = binding.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/u);
  if (namespaceMatch) {
    lines.push(`const ${namespaceMatch[1]} = ${moduleVar};`);
    return;
  }

  lines.push(`const ${binding} = ${moduleVar}.default ?? ${moduleVar};`);
}

function buildHostExternalImportReplacement(
  importClause: string,
  specifier: string,
  index: number,
): string {
  const moduleVar = `__tinyplace_host_external_${index}`;
  const lines = [
    `const ${moduleVar} = await globalThis.__ELIZA_DYNAMIC_VIEW_IMPORT__(${JSON.stringify(
      specifier,
    )});`,
  ];
  for (const binding of splitTopLevelImportClause(importClause.trim())) {
    appendHostExternalBinding(lines, moduleVar, binding);
  }
  return lines.join("\n");
}

function rewriteHostExternalImports(source: string): string {
  const specifierPattern = HOST_EXTERNAL_SPECIFIERS.map((item) =>
    item.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
  ).join("|");
  const fromImportPattern = new RegExp(
    `import\\s+([^;]*?)\\s+from\\s+["'](${specifierPattern})["'];?`,
    "gu",
  );
  let replacementIndex = 0;
  return source.replace(fromImportPattern, (_match, importClause, specifier) =>
    buildHostExternalImportReplacement(
      String(importClause),
      String(specifier),
      replacementIndex++,
    ),
  );
}

test.skip(
  !tinyPlaceBundlePath || !existsSync(tinyPlaceBundlePath),
  "set TINYPLACE_ELIZAOS_PLUGIN_DIR to a built tiny.place checkout to run this host smoke",
);

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
  installPageDiagnosticsGuard(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await expectNoPageDiagnostics(page, testInfo.title);
});

test("tiny.place plugin view mounts in Eliza and pre-fills chat actions", async ({
  page,
}) => {
  const bundle = readFileSync(tinyPlaceBundlePath as string, "utf8");
  const hostExternalBundle = rewriteHostExternalImports(bundle);

  await page
    .context()
    .route("**/api/views/tinyplace/bundle.js**", async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body:
          url.searchParams.get("hostExternalRuntime") === "1"
            ? hostExternalBundle
            : bundle,
      });
    });

  await page.route("**/api/views**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/views/search") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: [
            {
              id: "tinyplace",
              label: "tiny.place",
              description: "Agent identity, directory, and encrypted messaging",
              pluginName: TINYPLACE_PACKAGE_NAME,
              path: "/tinyplace",
              available: true,
              visibleInManager: true,
            },
          ],
        }),
      });
      return;
    }
    if (url.pathname !== "/api/views") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        views: [
          {
            id: "tinyplace",
            label: "tiny.place",
            description: "Agent identity, directory, and encrypted messaging",
            viewType: "gui",
            pluginName: TINYPLACE_PACKAGE_NAME,
            path: "/tinyplace",
            bundleUrl: "/api/views/tinyplace/bundle.js",
            componentExport: "TinyPlaceView",
            available: true,
            visibleInManager: true,
            desktopTabEnabled: true,
            tags: ["tinyplace", "agents", "directory", "messaging", "signal"],
          },
        ],
      }),
    });
  });

  await openAppPath(page, "/tinyplace");

  const view = page.getByTestId("tinyplace-view");
  await expect(view).toBeVisible({ timeout: 30_000 });
  await expect(view.getByRole("heading", { name: "tiny.place" })).toBeVisible();
  await expect(view).toHaveAttribute(
    "data-tinyplace-selected-action",
    "TINYPLACE_IDENTITY",
  );
  await expect(view).toHaveAttribute("data-view-state", /"viewId":"tinyplace"/);

  await page
    .locator('[data-tinyplace-action="TINYPLACE_SEND_MESSAGE"]')
    .click();

  await expect(view).toHaveAttribute(
    "data-tinyplace-selected-action",
    "TINYPLACE_SEND_MESSAGE",
  );
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toHaveValue(
    "Help me send a tiny.place encrypted message.",
  );
  await expect(composer).toBeFocused();
});
