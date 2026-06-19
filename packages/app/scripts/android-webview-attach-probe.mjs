#!/usr/bin/env node
// De-risk probe: prove Playwright's Android driver can attach to the on-device
// Capacitor WebView and drive it as a Page. Launches the app, connects over
// adb, finds the app WebView, and reports url/title + screenshot. Exits non-zero
// with a clear reason if the WebView is not debuggable (the usual cause being an
// APK built without ELIZA_WEBVIEW_DEBUG=1).
import { _android as android } from "@playwright/test";
import {
  APP_ID,
  appPid,
  connectPlaywrightDevice,
  launchApp,
  resolveAdb,
  resolveSerial,
} from "./lib/android-device.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const adb = resolveAdb();
  const serial = resolveSerial(adb, argValue("--serial"));
  console.log(`[attach-probe] serial=${serial} appId=${APP_ID}`);

  launchApp(adb, serial);
  // Give the WebView time to attach its DevTools socket.
  for (let i = 0; i < 20 && !appPid(adb, serial); i += 1) await delay(500);
  await delay(4_000);

  const device = await connectPlaywrightDevice(android, serial);
  console.log(
    `[attach-probe] connected model=${device.model()} serial=${device.serial()}`,
  );

  let webview;
  try {
    webview = await device.webView({ pkg: APP_ID }, { timeout: 30_000 });
  } catch (error) {
    const views = device.webViews().map((w) => w.pkg?.() ?? "?");
    throw new Error(
      `Could not find a debuggable WebView for ${APP_ID}. ` +
        `Visible webviews: ${JSON.stringify(views)}. ` +
        `Build the APK with ELIZA_WEBVIEW_DEBUG=1. Original: ${error.message}`,
    );
  }

  const page = await webview.page();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  const url = page.url();
  const title = await page.title().catch(() => "<title-unavailable>");
  const rootVisible = await page
    .locator("#root")
    .isVisible()
    .catch(() => false);
  const screenshot = argValue("--screenshot", "/tmp/android-attach-probe.png");
  // Android WebView screenshots are slow over CDP; keep it short + non-fatal.
  await page
    .screenshot({ path: screenshot, timeout: 8_000, animations: "disabled" })
    .catch((e) =>
      console.warn(`[attach-probe] screenshot skipped: ${e.message}`),
    );

  console.log(
    JSON.stringify(
      { ok: true, url, title, rootVisible, screenshot, model: device.model() },
      null,
      2,
    ),
  );
  await device.close();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[attach-probe] ${error?.message ?? error}`);
    process.exit(1);
  });
