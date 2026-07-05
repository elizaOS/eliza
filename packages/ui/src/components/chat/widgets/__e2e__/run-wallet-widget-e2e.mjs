/**
 * Real-browser screenshot + assertion harness for the WALLET home widget
 * (#14344) — no app server. Bundles wallet-widget-fixture.tsx (the REAL
 * `WalletBalanceWidget`) with esbuild, stubs only the `../../../api` client,
 * auth, and nav modules, loads it in headless chromium, and proves both states:
 *
 *   - DEFAULT (no holdings): the tracked BTC/SOL/ETH price rows are shown
 *     (previously the widget rendered nothing here — the bug this fixes).
 *   - HELD (≥1 priced holding): the top-3 held by holding value, price-only.
 *
 * Captures a screenshot of each state for inline PR evidence.
 *
 * Run: bun run --cwd packages/ui test:wallet-widget-e2e
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const stylesDir = join(here, "../../../../styles");
const outDir = join(here, "output-wallet");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

const baseCss = await readFile(join(stylesDir, "base.css"), "utf8");
// The widget uses semantic text tokens that tailwind's CDN default config does
// not know; map them to readable colours on the orange field for the capture.
const TOKEN_SHIM = `
.text-muted{color:rgba(255,255,255,0.72)}
.text-txt-strong{color:#ffffff}
.text-success{color:#bbf7d0}
.text-danger{color:#fecaca}
`;

// Client + hook stubs: the widget fetches balances/overview from the api module
// singleton, so we replace it with a state-driven stub (chosen by ?state=held).
const apiStub = join(outDir, "api-stub.ts");
await writeFile(
  apiStub,
  `const held = new URLSearchParams(location.search).get("state") === "held";
const overview = {
  generatedAt: "", cacheTtlSeconds: 120, stale: false,
  sources: {}, predictions: [], movers: [],
  prices: [
    { id: "bitcoin", symbol: "BTC", name: "Bitcoin", priceUsd: 64000, change24hPct: 1.2, imageUrl: null },
    { id: "ethereum", symbol: "ETH", name: "Ethereum", priceUsd: 3000, change24hPct: -0.5, imageUrl: null },
    { id: "solana", symbol: "SOL", name: "Solana", priceUsd: 150, change24hPct: 2.1, imageUrl: null },
    { id: "usd-coin", symbol: "USDC", name: "USD Coin", priceUsd: 1.0, change24hPct: 0.0, imageUrl: null },
  ],
};
const heldBalances = {
  evm: { address: "0xabc", chains: [{ chain: "ethereum", chainId: 1, nativeBalance: "0",
    nativeSymbol: "ETH", nativeValueUsd: "5000", error: null, tokens: [
      { symbol: "USDC", name: "USD Coin", balance: "0", decimals: 6, valueUsd: "800", address: "0xusdc" },
    ] }] },
  solana: { address: "sol1", solBalance: "0", solValueUsd: "2000", tokens: [] },
};
export const client = {
  getWalletBalances: async () => (held ? heldBalances : { evm: null, solana: null }),
  getWalletMarketOverview: async () => overview,
};
`,
);
const authStub = join(outDir, "auth-stub.ts");
await writeFile(authStub, `export function useIsAuthenticated() { return true; }\n`);
const navStub = join(outDir, "nav-stub.ts");
await writeFile(
  navStub,
  `export function useWidgetNavigation() { return { openView() {}, openTab() {} }; }\n`,
);

const stubModules = {
  name: "stub-wallet-deps",
  setup(b) {
    b.onResolve({ filter: /\/api$/ }, () => ({ path: apiStub }));
    b.onResolve({ filter: /useAuthStatus$/ }, () => ({ path: authStub }));
    b.onResolve({ filter: /home-widget-card$/ }, () => ({ path: navStub }));
  },
};

const result = await build({
  entryPoints: [join(here, "wallet-widget-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubModules],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>wallet widget e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>${baseCss}</style>
<style>${TOKEN_SHIM}</style>
<style>html,body{margin:0;height:100%}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "wallet-widget.html");
await writeFile(htmlPath, html);

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 420, height: 560 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // DEFAULT state — no holdings, BTC/SOL/ETH rows must appear (the bug fix).
  await page.goto(`file://${htmlPath}?state=default`);
  await page.waitForSelector('[data-testid="chat-widget-wallet-prices"]', {
    timeout: 8000,
  });
  const defaultRows = await page
    .locator('[data-testid^="wallet-price-row-"]')
    .evaluateAll((els) => els.map((e) => e.dataset.testid));
  assert(
    JSON.stringify(defaultRows) ===
      JSON.stringify([
        "wallet-price-row-BTC",
        "wallet-price-row-SOL",
        "wallet-price-row-ETH",
      ]),
    `DEFAULT state shows BTC/SOL/ETH rows (got ${JSON.stringify(defaultRows)})`,
  );
  await page.screenshot({ path: join(outDir, "wallet-default.png") });
  console.log("  📸 wallet-default.png");

  // HELD state — top-3 priced holdings by holding value: ETH $5000, SOL $2000, USDC $800.
  await page.goto(`file://${htmlPath}?state=held`);
  await page.waitForSelector('[data-testid="chat-widget-wallet-prices"]', {
    timeout: 8000,
  });
  const heldRows = await page
    .locator('[data-testid^="wallet-price-row-"]')
    .evaluateAll((els) => els.map((e) => e.dataset.testid));
  assert(
    JSON.stringify(heldRows) ===
      JSON.stringify([
        "wallet-price-row-ETH",
        "wallet-price-row-SOL",
        "wallet-price-row-USDC",
      ]),
    `HELD state shows top-3 held by value ETH/SOL/USDC (got ${JSON.stringify(heldRows)})`,
  );
  // Price-only invariant (#10706): the $5000/$2000/$800 holding values must NOT leak.
  const heldText = await page
    .locator('[data-testid="chat-widget-wallet-prices"]')
    .innerText();
  assert(
    !heldText.includes("5,000") && !heldText.includes("2,000") && !heldText.includes("800"),
    "HELD state leaks no holding values (price-only #10706)",
  );
  await page.screenshot({ path: join(outDir, "wallet-held.png") });
  console.log("  📸 wallet-held.png");

  assert(errors.length === 0, `no page errors (${errors.length})`);
  for (const e of errors) console.log("  ERR:", e);
  await ctx.close();
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll wallet-widget assertions passed.");
