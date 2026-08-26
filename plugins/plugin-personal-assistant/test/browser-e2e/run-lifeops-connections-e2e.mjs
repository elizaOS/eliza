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

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LifeOps no-provider acceptance</title><style>:root{color-scheme:dark;--brand-white:#fdfaf7;--brand-black:#000;--txt:var(--brand-white);--muted:rgba(255,255,255,.56);--bg:var(--brand-black);--card:#121212;--bg-muted:rgba(255,255,255,.06);--bg-accent:var(--brand-black);--accent:#ff6a1f;--accent-muted:#c94400;--accent-foreground:var(--brand-black);--accent-subtle:rgba(255,106,31,.14);--border:rgba(255,255,255,.12);--border-strong:rgba(255,255,255,.22);--destructive:#ff6a1f;--destructive-foreground:var(--brand-black);--destructive-subtle:rgba(255,106,31,.12);--status-success:#4ade80;--status-success-bg:rgba(74,222,128,.16);--status-warning:#ff6a1f;--status-warning-bg:rgba(255,106,31,.12);--status-danger:#ff6a1f;--status-danger-bg:rgba(255,106,31,.12);--scrim:rgba(0,0,0,.72)}html,body,#root{width:100%;height:100%;margin:0;background:var(--bg);color:var(--txt);font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}*{box-sizing:border-box}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`;
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
const holdOpen = process.env.LIFEOPS_E2E_HOLD_OPEN === "1";
let failures = 0;
function assert(condition, message) {
  process.stdout.write(`${condition ? "PASS" : "FAIL"} ${message}\n`);
  if (!condition) failures += 1;
}

function relativeLuminance(color) {
  const [red, green, blue] = color
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map((value) => Number(value) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground, background) {
  const light = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const dark = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (light + 0.05) / (dark + 0.05);
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
  const initialColors = await desktop
    .getByRole("heading", { name: /Bring your inbox/ })
    .evaluate((heading) => ({
      foreground: getComputedStyle(heading).color,
      background: getComputedStyle(document.body).backgroundColor,
    }));
  assert(
    contrastRatio(initialColors.foreground, initialColors.background) >= 7,
    "primary text keeps enhanced contrast in the standalone fixture",
  );
  const primaryButton = desktop.getByRole("button", {
    name: "Seed selected context",
  });
  const primaryRestColors = await primaryButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      foreground: style.color,
      background: style.backgroundColor,
    };
  });
  assert(
    contrastRatio(primaryRestColors.foreground, primaryRestColors.background) >=
      4.5,
    "primary action resting contrast remains WCAG AA",
  );
  await primaryButton.hover();
  const primaryHoverColors = await primaryButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      foreground: style.color,
      background: style.backgroundColor,
    };
  });
  assert(
    contrastRatio(
      primaryHoverColors.foreground,
      primaryHoverColors.background,
    ) >= 4.5,
    "primary action hover contrast remains WCAG AA",
  );
  assert(
    relativeLuminance(primaryHoverColors.background) <
      relativeLuminance(primaryRestColors.background),
    "primary action hover is darker than its resting orange",
  );
  await desktop.screenshot({
    path: join(outputDir, "desktop-primary-hover.png"),
    fullPage: true,
    animations: "disabled",
  });
  await desktop.mouse.move(0, 0);
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
  assert(
    (await desktop.getByText(/Some calendar sources failed/).count()) === 0 &&
      (await desktop.getByTestId("seed-receipt").count()) === 1,
    "partial failure recovers through an explicit retry",
  );

  await desktop
    .getByRole("button", { name: /Purge imported Google data/ })
    .click();
  assert(
    await desktop.getByRole("alertdialog").isVisible(),
    "local projection purge requires confirmation",
  );
  assert(
    (await desktop.evaluate(() =>
      document.activeElement?.textContent?.trim(),
    )) === "Cancel",
    "destructive confirmation receives keyboard focus",
  );
  await desktop.keyboard.press("Escape");
  await desktop.getByRole("alertdialog").waitFor({ state: "detached" });
  assert(
    (await desktop.getByRole("alertdialog").count()) === 0 &&
      (await desktop.getByTestId("purge-receipt").count()) === 0,
    "Escape cancels a destructive confirmation without an effect",
  );
  await desktop
    .getByRole("button", { name: /Purge imported Google data/ })
    .click();
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
    !(await desktop
      .getByRole("button", { name: "Seed selected context" })
      .isDisabled()),
    "disconnect clears stale Google identity while preserving Apple-only seed",
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
  await desktop.getByRole("button", { name: "Review inbox drafts" }).click();
  assert(
    (await desktop.evaluate(
      () => document.documentElement.dataset.lastNavigation,
    )) === "/inbox",
    "draft review stays separate from sending",
  );
  await desktop
    .getByRole("button", { name: "Review calendar changes" })
    .click();
  assert(
    (await desktop.evaluate(
      () => document.documentElement.dataset.lastNavigation,
    )) === "/calendar",
    "calendar review stays separate from provider mutation",
  );
  assert(pageErrors.length === 0, "desktop flow has no page errors");

  const multiAccount = await browser.newPage({
    viewport: { width: 1180, height: 850 },
  });
  await multiAccount.goto(`${baseURL}?scenario=multi-account`);
  await multiAccount
    .getByRole("combobox", { name: "Active Google account" })
    .selectOption("connector-account:fixture-account-2");
  await multiAccount
    .getByRole("button", { name: "Seed selected context" })
    .click();
  await multiAccount.getByTestId("seed-receipt").waitFor();
  const multiSeed = JSON.parse(
    await multiAccount.evaluate(
      () => document.documentElement.dataset.seedRequest ?? "null",
    ),
  );
  assert(
    multiSeed.grantId === "connector-account:fixture-account-2" &&
      multiSeed.calendarKeys.some((key) =>
        key.includes("fixture-second-primary"),
      ) &&
      multiSeed.calendarKeys.some((key) => key.includes("fixture-apple")) &&
      !multiSeed.calendarKeys.some((key) => key.endsWith('"primary"]')),
    "account switching excludes hidden calendars from another Google grant",
  );
  await multiAccount.close();

  const appleOnly = await browser.newPage({
    viewport: { width: 1024, height: 800 },
  });
  await appleOnly.goto(`${baseURL}?scenario=apple-only&permission=granted`);
  await appleOnly.getByText("No Google account is connected.").waitFor();
  assert(
    !(await appleOnly
      .getByRole("button", { name: "Seed selected context" })
      .isDisabled()),
    "Apple Calendar can seed without a fabricated Google grant",
  );
  await appleOnly
    .getByRole("button", { name: "Seed selected context" })
    .click();
  await appleOnly.getByTestId("seed-receipt").waitFor();
  const appleSeed = JSON.parse(
    await appleOnly.evaluate(
      () => document.documentElement.dataset.seedRequest ?? "null",
    ),
  );
  assert(
    appleSeed.grantId === null &&
      appleSeed.includeGmail === false &&
      appleSeed.calendarKeys.length === 1,
    "Apple-only seed receipt preserves provider-neutral identity",
  );
  await appleOnly.screenshot({
    path: join(outputDir, "desktop-apple-only.png"),
    fullPage: true,
    animations: "disabled",
  });
  await appleOnly.close();

  const capabilityPage = await browser.newPage({
    viewport: { width: 1024, height: 800 },
  });
  await capabilityPage.goto(`${baseURL}?scenario=capture-connect`);
  assert(
    await capabilityPage
      .getByRole("checkbox", { name: /Create drafts/ })
      .isChecked(),
    "draft capability defaults on without implying send",
  );
  for (const name of [
    /Send approved email/,
    /Manage labels and mailbox state/,
    /Change Google Calendar/,
  ]) {
    const checkbox = capabilityPage.getByRole("checkbox", { name });
    assert(!(await checkbox.isChecked()), `${name.source} effect defaults off`);
    await checkbox.check();
  }
  await capabilityPage
    .getByRole("button", { name: /Connect another Google account/ })
    .click();
  const requestedCapabilities = JSON.parse(
    await capabilityPage.evaluate(
      () => document.documentElement.dataset.connectCapabilities ?? "[]",
    ),
  );
  assert(
    requestedCapabilities.includes("google.gmail.send") &&
      requestedCapabilities.includes("google.gmail.manage") &&
      requestedCapabilities.includes("google.calendar.write"),
    "effect scopes are requested only after explicit selection",
  );
  await capabilityPage.close();

  for (const [permission, label] of [
    ["limited", "Write only"],
    ["restricted", "Restricted"],
    ["not-applicable", "Not available here"],
  ]) {
    const permissionPage = await browser.newPage();
    await permissionPage.goto(`${baseURL}?permission=${permission}`);
    assert(
      await permissionPage.getByText(label, { exact: true }).isVisible(),
      `Apple ${permission} permission state is explicit`,
    );
    await permissionPage.close();
  }

  const requestPermission = await browser.newPage();
  await requestPermission.goto(`${baseURL}?permission=not-determined`);
  await requestPermission
    .getByRole("button", { name: "Request permission" })
    .click();
  await requestPermission.getByText("Full access", { exact: true }).waitFor();
  assert(
    (await requestPermission
      .getByText("Full access", { exact: true })
      .isVisible()) &&
      (await requestPermission
        .getByRole("button", { name: "Request permission" })
        .count()) === 0,
    "Apple permission request refreshes to the granted state",
  );
  await requestPermission.close();

  const faultCases = [
    {
      query: "failure=load",
      expected: "Fixture connection inventory failed.",
      act: async (page) => {
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await page
          .getByRole("combobox", { name: "Active Google account" })
          .waitFor();
      },
      message:
        "initial inventory failure recovers without fabricated empty state",
    },
    {
      query: "failure=seed",
      expected: "Fixture initial sync failed during calendar import.",
      act: async (page) => {
        await page
          .getByRole("button", { name: "Seed selected context" })
          .click();
      },
      message: "partial seed failure is explicit and retryable",
    },
    {
      query: "failure=calendar",
      expected: "Fixture calendar selection could not be saved.",
      act: async (page) => {
        await page.getByRole("checkbox", { name: /Work/ }).click();
      },
      message: "calendar-selection failure preserves the prior selection",
    },
    {
      query: "failure=permission&permission=not-determined",
      expected: "Fixture Calendar permission request failed.",
      act: async (page) => {
        await page.getByRole("button", { name: "Request permission" }).click();
      },
      message: "Apple permission request failure is actionable",
    },
    {
      query: "failure=settings",
      expected: "Fixture System Settings launch failed.",
      act: async (page) => {
        await page
          .getByRole("button", { name: "Open System Settings" })
          .click();
      },
      message: "System Settings launch failure is actionable",
    },
    {
      query: "failure=purge",
      expected: "Fixture local purge failed; no data was removed.",
      act: async (page) => {
        await page
          .getByRole("button", { name: /Purge imported Google data/ })
          .click();
        await page.getByRole("button", { name: "Confirm purge" }).click();
      },
      message: "failed local purge never displays a success receipt",
    },
    {
      query: "failure=disconnect",
      expected: "Fixture disconnect failed; connection is unchanged.",
      act: async (page) => {
        await page
          .getByRole("button", { name: /Disconnect Google account/ })
          .click();
        await page.getByRole("button", { name: "Confirm disconnect" }).click();
      },
      message: "failed disconnect keeps the account visibly connected",
    },
    {
      query: "scenario=capture-connect&failure=connect",
      expected: "Fixture Google connect failed.",
      act: async (page) => {
        await page
          .getByRole("button", { name: /Connect another Google account/ })
          .click();
      },
      message: "Google connect failure restores controls and reports the cause",
    },
  ];
  for (const fault of faultCases) {
    const faultPage = await browser.newPage();
    const faultErrors = [];
    faultPage.on("pageerror", (error) => faultErrors.push(String(error)));
    await faultPage.goto(`${baseURL}?${fault.query}`);
    await faultPage
      .getByRole("heading", { name: /Bring your inbox/ })
      .waitFor();
    if (fault.query === "failure=load") {
      await faultPage.getByRole("alert").waitFor();
    } else {
      await fault.act(faultPage);
      await faultPage.getByRole("alert").waitFor();
    }
    assert(
      (await faultPage.getByRole("alert").textContent()).includes(
        fault.expected,
      ),
      fault.message,
    );
    if (fault.query === "failure=load") await fault.act(faultPage);
    if (fault.query === "failure=calendar") {
      assert(
        await faultPage.getByRole("checkbox", { name: /Work/ }).isChecked(),
        "failed calendar selection remains checked",
      );
    }
    if (fault.query === "failure=purge") {
      assert(
        (await faultPage.getByTestId("purge-receipt").count()) === 0,
        "failed purge emits no success receipt",
      );
    }
    if (fault.query === "failure=disconnect") {
      assert(
        await faultPage
          .getByRole("combobox", { name: "Active Google account" })
          .isVisible(),
        "failed disconnect preserves connected account state",
      );
    }
    assert(
      faultErrors.length === 0,
      `${fault.query} has no uncaught page error`,
    );
    await faultPage.close();
  }

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
}

process.stdout.write(`Evidence: ${outputDir}\n`);
if (failures > 0) process.exitCode = 1;
if (holdOpen && failures === 0) {
  process.stdout.write(`Inspection URL: ${baseURL}\n`);
  await new Promise((resolveHold) => {
    process.once("SIGINT", resolveHold);
    process.once("SIGTERM", resolveHold);
  });
}
server.stop(true);
