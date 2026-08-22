/**
 * Real-Chromium, no-provider acceptance harness for LifeOps connections.
 * It serves an isolated in-memory fixture on port 41873 by default and writes
 * screenshots only to a temporary directory outside the repository.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build as viteBuild } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const port = Number.parseInt(process.env.LIFEOPS_E2E_PORT ?? "41873", 10);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 50001) {
  throw new Error(
    "LIFEOPS_E2E_PORT must be a non-native port from 1024 to 65535.",
  );
}

const adapterStub = join(here, "lifeops-connections-adapter-stub.ts");
const result = await viteBuild({
  configFile: false,
  root: repoRoot,
  resolve: { conditions: ["eliza-source", "browser"] },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "lifeops-production-adapter-stub",
      enforce: "pre",
      resolveId(source, importer) {
        return source === "./adapter.js" &&
          importer?.endsWith("LifeOpsConnectionsView.tsx")
          ? adapterStub
          : null;
      },
    },
  ],
  build: {
    write: false,
    minify: false,
    rollupOptions: {
      input: join(here, "lifeops-connections-fixture.tsx"),
      output: { format: "iife", inlineDynamicImports: true },
    },
  },
});
const buildResult = Array.isArray(result) ? result[0] : result;
const bundle = buildResult.output.find(
  (entry) => entry.type === "chunk" && entry.isEntry,
)?.code;
if (!bundle) throw new Error("LifeOps fixture bundle was empty.");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LifeOps no-provider acceptance</title><style>html,body,#root{width:100%;height:100%;margin:0;background:#0b0b0b;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}*{box-sizing:border-box}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});

const outputDir = await mkdtemp(join(tmpdir(), "eliza-lifeops-e2e-"));
const baseURL = `http://127.0.0.1:${port}`;
let failures = 0;
function assert(condition, message) {
  process.stdout.write(`${condition ? "PASS" : "FAIL"} ${message}\n`);
  if (!condition) failures += 1;
}

const browser = await chromium.launch({ headless: true });
try {
  const desktop = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const pageErrors = [];
  desktop.on("pageerror", (error) => pageErrors.push(String(error)));
  await desktop.goto(baseURL);
  await desktop.getByRole("heading", { name: /Bring your inbox/ }).waitFor();
  assert(
    await desktop.getByText(/Some calendar sources failed/).isVisible(),
    "partial source failure is explicit",
  );
  assert(
    await desktop.getByText(/History cursor: incremental/).isVisible(),
    "Gmail History cursor health is visible",
  );
  assert(
    await desktop.getByText("Permission denied").isVisible(),
    "Apple permission denial is actionable",
  );
  await desktop.screenshot({
    path: join(outputDir, "desktop-initial.png"),
    fullPage: true,
    animations: "disabled",
  });

  await desktop.getByRole("radio", { name: "7 days" }).check();
  await desktop.getByRole("button", { name: "Seed selected context" }).click();
  await desktop.getByTestId("seed-receipt").waitFor();
  assert(
    (await desktop.getByTestId("seed-receipt").textContent()).includes(
      "6 Gmail messages and 5 calendar events from 2 sources",
    ),
    "bounded cross-provider seed reports counts",
  );
  await desktop.screenshot({
    path: join(outputDir, "desktop-seeded.png"),
    fullPage: true,
    animations: "disabled",
  });

  await desktop
    .getByRole("button", {
      name: "Retry all connection checks and synchronization",
    })
    .click();
  await desktop.getByText(/Some calendar sources failed/).waitFor({
    state: "detached",
  });
  assert(true, "partial failure recovers through an explicit retry");

  await desktop
    .getByRole("button", { name: /Purge imported Google data/ })
    .click();
  assert(
    await desktop.getByRole("alertdialog").isVisible(),
    "local projection purge requires confirmation",
  );
  await desktop.getByRole("button", { name: "Confirm purge" }).click();
  await desktop.getByTestId("purge-receipt").waitFor();
  assert(
    (await desktop.getByTestId("purge-receipt").textContent()).includes(
      "Providers were not changed",
    ),
    "purge receipt denies provider mutation",
  );

  await desktop
    .getByRole("button", { name: /Disconnect Google account/ })
    .click();
  await desktop.getByRole("button", { name: "Confirm disconnect" }).click();
  await desktop.getByText("No Google account is connected.").waitFor();
  assert(
    await desktop
      .getByRole("button", { name: "Seed selected context" })
      .isDisabled(),
    "disconnect clears stale grant selection",
  );
  await desktop.screenshot({
    path: join(outputDir, "desktop-disconnected.png"),
    fullPage: true,
    animations: "disabled",
  });

  await desktop.getByRole("button", { name: /Continue to Google/ }).click();
  await desktop
    .getByRole("combobox", { name: "Active Google account" })
    .waitFor();
  await desktop.getByRole("button", { name: "Seed selected context" }).click();
  await desktop.getByTestId("seed-receipt").waitFor();
  assert(
    (await desktop.getByTestId("seed-receipt").textContent()).includes(
      "6 Gmail messages and 5 calendar events",
    ),
    "reconnect reuses stable identities without duplicate counts",
  );
  assert(pageErrors.length === 0, "desktop flow has no page errors");

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const mobileErrors = [];
  mobile.on("pageerror", (error) => mobileErrors.push(String(error)));
  await mobile.goto(baseURL);
  await mobile.getByRole("heading", { name: /Bring your inbox/ }).waitFor();
  const fitsViewport = await mobile.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  assert(fitsViewport, "mobile layout has no horizontal overflow");
  const shortButtonCount = await mobile
    .locator("button")
    .evaluateAll(
      (buttons) =>
        buttons.filter((button) => button.getBoundingClientRect().height < 44)
          .length,
    );
  assert(shortButtonCount === 0, "mobile buttons meet the 44px touch target");
  await mobile.screenshot({
    path: join(outputDir, "mobile-initial.png"),
    fullPage: true,
    animations: "disabled",
  });
  assert(mobileErrors.length === 0, "mobile flow has no page errors");
  await mobile.close();
  await desktop.close();
} finally {
  await browser.close();
  server.stop(true);
}

process.stdout.write(`Evidence: ${outputDir}\n`);
if (failures > 0) process.exitCode = 1;
