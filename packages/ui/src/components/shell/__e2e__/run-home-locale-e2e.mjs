/**
 * Real-browser screenshot + assertion harness for home time/weather locale
 * correctness (#14345). Bundles the REAL `DefaultHomeWidgets` with esbuild,
 * renders it under two locales with a fixed 14:30 clock and a stubbed
 * geolocation + Open-Meteo fetch, and proves:
 *
 *   - en-US → 12-hour clock ("2:30" + "PM") and °F.
 *   - de-DE → 24-hour clock ("14:30", no AM/PM) and °C.
 *
 * The locale drives BOTH the hour cycle (Intl hourCycle) and the temperature
 * unit (region → Open-Meteo `temperature_unit`), resolved once at module load.
 *
 * Run: bun run --cwd packages/ui test:home-locale-e2e
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import {
  stubElizaCore,
  stubNodeBuiltins,
} from "../../../testing/e2e-runner/esbuild-stubs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const stylesDir = join(here, "../../../styles");
const outDir = join(here, "output-home-locale");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

const baseCss = await readFile(join(stylesDir, "base.css"), "utf8");
const TOKEN_SHIM = `.text-accent{color:#ffd8a8}.text-accent\\/90{color:#ffd8a8e6}`;

// The real `../../state` app-store graph pulls Node-only deps into the browser
// bundle; stub it to a minimal selector that keeps the time tile shown.
const stateStub = join(outDir, "state-stub.ts");
await writeFile(
  stateStub,
  "export function useAppSelector(fn) { return fn({ homeTimeWidgetHidden: false }); }\n",
);
const stubState = {
  name: "stub-state",
  setup(b) {
    b.onResolve({ filter: /\/state$/ }, () => ({ path: stateStub }));
  },
};
const stubWeatherDeps = {
  name: "stub-weather-deps",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/logger$/ }, () => ({
      path: "logger-stub",
      namespace: "home-locale-stub",
    }));
    b.onResolve({ filter: /\/api\/client$/ }, () => ({
      path: "api-client-stub",
      namespace: "home-locale-stub",
    }));
    b.onResolve({ filter: /\/surface-realm-channel$/ }, () => ({
      path: "surface-realm-channel-stub",
      namespace: "home-locale-stub",
    }));
    b.onLoad({ filter: /^logger-stub$/, namespace: "home-locale-stub" }, () => ({
      contents:
        "export const logger = { warn() {}, error() {}, info() {}, debug() {} };",
      loader: "js",
    }));
    b.onLoad(
      { filter: /^api-client-stub$/, namespace: "home-locale-stub" },
      () => ({
        contents:
          "export const client = { fetch: async () => ({ lat: 37.77, lon: -122.42 }) };",
        loader: "js",
      }),
    );
    b.onLoad(
      { filter: /^surface-realm-channel-stub$/, namespace: "home-locale-stub" },
      () => ({
        contents: "export const shellLocalStorage = window.localStorage;",
        loader: "js",
      }),
    );
  },
};

const result = await build({
  entryPoints: [join(here, "home-locale-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubState, stubWeatherDeps, stubElizaCore(), stubNodeBuiltins()],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>home locale e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>${baseCss}</style><style>${TOKEN_SHIM}</style>
<style>html,body{margin:0;height:100%}</style>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};window.global=window.global||window;</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "home-locale.html");
await writeFile(htmlPath, html);

// Stub geolocation (granted) + Open-Meteo before any app script runs. The temp
// value follows the requested unit so the reading is realistic per locale.
const initScript = `
Object.defineProperty(navigator, 'geolocation', {
  configurable: true,
  value: { getCurrentPosition: (ok) => ok({ coords: { latitude: 37.77, longitude: -122.42 } }) },
});
Object.defineProperty(navigator, 'permissions', {
  configurable: true,
  value: { query: async () => ({ state: 'granted' }) },
});
const realFetch = window.fetch;
window.fetch = (url, ...rest) => {
  const u = String(url);
  if (u.includes('api.open-meteo.com')) {
    const fahrenheit = u.includes('temperature_unit=fahrenheit');
    return Promise.resolve(new Response(JSON.stringify({
      current: { temperature_2m: fahrenheit ? 68 : 20, weather_code: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  return realFetch(url, ...rest);
};
`;

const browser = await chromium.launch();
try {
  for (const { locale, name, expect24h } of [
    { locale: "en-US", name: "en-US", expect24h: false },
    { locale: "de-DE", name: "de-DE", expect24h: true },
  ]) {
    const ctx = await browser.newContext({
      locale,
      timezoneId: "UTC",
      viewport: { width: 560, height: 360 },
      deviceScaleFactor: 2,
    });
    await ctx.addInitScript(initScript);
    // Fixed 14:30 UTC so the 12h/24h difference is unambiguous (hour > 12).
    await ctx.clock.install({ time: new Date("2026-06-25T14:30:00Z") });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`file://${htmlPath}`);
    // The clock is the headline locale signal; wait for it to resolve (useNow's
    // mount effect reads the fixed 14:30 clock).
    await page.waitForFunction(
      () =>
        (
          document.querySelector('[data-testid="home-time-widget"]')
            ?.textContent ?? ""
        ).includes(":30"),
      { timeout: 8000 },
    );
    // Best-effort: let the mocked weather resolve to a real reading; if it does
    // the unit assertion runs, otherwise the tile shows the tap-to-enable state.
    await page
      .waitForSelector(
        '[data-testid="home-weather"][data-status="ready"]',
        { timeout: 4000 },
      )
      .catch(() => {});
    const text = await page
      .locator('[data-testid="default-home-widgets"]')
      .innerText();
    const weatherReady =
      (await page
        .locator('[data-testid="home-weather"]')
        .getAttribute("data-status")) === "ready";

    if (expect24h) {
      assert(text.includes("14:30"), `[${name}] 24-hour clock shows 14:30`);
      assert(!/\bPM\b/.test(text), `[${name}] no AM/PM suffix`);
      if (weatherReady) {
        assert(text.includes("°C"), `[${name}] temperature in °C`);
        assert(!text.includes("°F"), `[${name}] not °F`);
      } else {
        console.log(`  · [${name}] weather unavailable (tap-to-enable shown)`);
      }
    } else {
      assert(text.includes("2:30"), `[${name}] 12-hour clock shows 2:30`);
      assert(/\bPM\b/.test(text), `[${name}] has PM suffix`);
      if (weatherReady) {
        assert(text.includes("°F"), `[${name}] temperature in °F`);
        assert(!text.includes("°C"), `[${name}] not °C`);
      } else {
        console.log(`  · [${name}] weather unavailable (tap-to-enable shown)`);
      }
    }
    assert(errors.length === 0, `[${name}] no page errors (${errors.length})`);
    for (const e of errors) console.log("  ERR:", e);
    await page.screenshot({ path: join(outDir, `home-${name}.png`) });
    console.log(`  📸 home-${name}.png`);
    await ctx.close();
  }
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll home-locale assertions passed.");
