import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Locator, type Page, type Route } from "@playwright/test";

const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// One real bundled VRM (gzipped glTF) shipped under packages/app/dist/vrms/.
// The preview server serves the SPA + the real `vrms/eliza-N.vrm.gz` files, but
// the runtime boot-config it serves has no `vrmAssets`, so `getVrmUrl()` falls
// back to `bundled-1.vrm.gz` which 404s — the gz-decode of a tiny 404 page then
// throws "Invalid typed array length" inside three-vrm. We mock every
// `vrms/*.vrm.gz` request with a real asset so the companion canvas loads a
// model instead. Playwright bundles the test files, so `import.meta.url` points
// at the bundle, not source — resolve relative to process.cwd() (= packages/app/)
// where the suite always runs.
let cachedVrmGz: Buffer | null | undefined;
function bundledVrmGz(): Buffer | null {
  if (cachedVrmGz !== undefined) return cachedVrmGz;
  const candidates = [
    resolve(process.cwd(), "dist/vrms/eliza-1.vrm.gz"),
    resolve(process.cwd(), "packages/app/dist/vrms/eliza-1.vrm.gz"),
    resolve(process.cwd(), "../app/dist/vrms/eliza-1.vrm.gz"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        cachedVrmGz = readFileSync(c);
        return cachedVrmGz;
      } catch {
        /* try next */
      }
    }
  }
  cachedVrmGz = null;
  return cachedVrmGz;
}

function contentTypeForAsset(pathname: string): string {
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (pathname.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

async function fulfillPublicAsset(route: Route): Promise<boolean> {
  const url = new URL(route.request().url());
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (
    !relativePath.startsWith("brand/") &&
    !relativePath.startsWith("app-heroes/")
  ) {
    return false;
  }
  const assetPath = resolve(process.cwd(), "public", relativePath);
  if (!existsSync(assetPath)) return false;
  await route.fulfill({
    status: 200,
    headers: { "content-type": contentTypeForAsset(relativePath) },
    body: readFileSync(assetPath),
  });
  return true;
}

const ROOT_TIMEOUT_MS = 20_000;
const NAV_TIMEOUT_MS = 12_000;
// Ready checks only confirm route-level render markers after navigation.
// Full bootstrap waits use the surrounding test timeout and Playwright defaults.
const READY_CHECK_TIMEOUT_MS = 15_000;
const STARTUP_SETTLED_TIMEOUT_MS = 45_000;
const SMOKE_GENERATED_AT = "2026-01-01T00:00:00.000Z";
const STORAGE_SEEDED_KEY = "eliza:ui-smoke-storage-seeded";
const RENDER_TELEMETRY_EVENT = "eliza:render-telemetry";
const RENDER_TELEMETRY_ERRORS_KEY = "__ELIZA_RENDER_TELEMETRY_ERRORS__";
const RENDER_TELEMETRY_INSTALLED_KEY =
  "__ELIZA_RENDER_TELEMETRY_WATCHER_INSTALLED__";

const renderTelemetryGuardedPages = new WeakSet<Page>();
const browserDiagnosticIssuesByPage = new WeakMap<Page, string[]>();

type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

type EvaluatedReadyCheck = {
  check: ReadyCheck;
  passed: boolean;
};

type RenderTelemetryIssue = {
  name?: string;
  renderCount?: number;
  windowMs?: number;
  severity?: string;
};

function issueMessage(error: Error): string {
  return error.stack || error.message || String(error);
}

function shouldIgnoreRequestFailure(url: string, failureText: string): boolean {
  if (failureText.includes("net::ERR_ABORTED")) return true;
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  return false;
}

function shouldIgnoreHttpError(url: string, status: number): boolean {
  if (status < 400) return true;
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  return false;
}

export function installPageDiagnosticsGuard(page: Page): void {
  if (browserDiagnosticIssuesByPage.has(page)) return;

  const issues: string[] = [];
  browserDiagnosticIssuesByPage.set(page, issues);

  page.on("pageerror", (error) => {
    issues.push(`pageerror: ${issueMessage(error)}`);
  });

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    issues.push(`console.error: ${message.text()}`);
  });

  page.on("requestfailed", (request) => {
    const failureText = request.failure()?.errorText ?? "unknown";
    const url = request.url();
    if (shouldIgnoreRequestFailure(url, failureText)) return;
    issues.push(`requestfailed: ${request.method()} ${url} ${failureText}`);
  });

  page.on("response", (response) => {
    const status = response.status();
    const url = response.url();
    if (shouldIgnoreHttpError(url, status)) return;
    issues.push(`http.${status}: ${response.request().method()} ${url}`);
  });
}

export async function expectNoPageDiagnostics(
  page: Page,
  label: string,
): Promise<void> {
  const issues = browserDiagnosticIssuesByPage.get(page) ?? [];
  expect(
    issues,
    `[playwright-ui-smoke] ${label}: expected no browser console.error/pageerror/requestfailed diagnostics; actual=${JSON.stringify(
      issues,
      null,
      2,
    )}`,
  ).toEqual([]);
}

const SETTINGS_SECTION_IDS_BY_LABEL = new Map<string, string>([
  ["Basics", "identity"],
  ["Providers", "ai-model"],
  ["Runtime", "runtime"],
  ["Appearance", "appearance"],
  ["Voice", "voice"],
  ["Capabilities", "capabilities"],
  ["Apps", "apps"],
  ["Remote Plugins", "remote-plugins"],
  ["Connectors", "connectors"],
  ["App Permissions", "app-permissions"],
  ["Wallet & RPC", "wallet-rpc"],
  ["Permissions", "permissions"],
  ["Vault", "secrets"],
  ["Security", "security"],
  ["Updates", "updates"],
  ["Backup & Reset", "advanced"],
]);

const DEFAULT_APP_STORAGE: Record<string, string> = {
  "eliza:first-run-complete": "1",
  "eliza:setup:step": "activate",
  "eliza:ui-shell-mode": "native",
  "elizaos:active-server": JSON.stringify({
    id: "local:embedded",
    kind: "local",
    label: "This device",
  }),
};

export async function seedAppStorage(
  page: Page,
  overrides: Record<string, string> = {},
): Promise<void> {
  const storage = { ...DEFAULT_APP_STORAGE, ...overrides };
  await page.addInitScript(
    ({ entries, seededKey }) => {
      if (sessionStorage.getItem(seededKey) === "1") {
        return;
      }
      for (const [key, value] of Object.entries(entries)) {
        localStorage.setItem(key, value);
      }
      sessionStorage.setItem(seededKey, "1");
    },
    { entries: storage, seededKey: STORAGE_SEEDED_KEY },
  );
}

export async function installRenderTelemetryGuard(page: Page): Promise<void> {
  if (renderTelemetryGuardedPages.has(page)) return;
  renderTelemetryGuardedPages.add(page);

  await page.addInitScript(
    ({ eventName, errorsKey, installedKey }) => {
      const win = window as Window &
        Record<string, unknown> & {
          [key: string]: unknown;
        };
      if (win[installedKey]) return;
      win[installedKey] = true;
      win[errorsKey] = [];
      window.addEventListener(eventName, (event) => {
        const detail = (event as CustomEvent<RenderTelemetryIssue>).detail;
        if (detail?.severity !== "error") return;
        const errors = win[errorsKey];
        if (Array.isArray(errors)) {
          errors.push(detail);
        }
      });
    },
    {
      eventName: RENDER_TELEMETRY_EVENT,
      errorsKey: RENDER_TELEMETRY_ERRORS_KEY,
      installedKey: RENDER_TELEMETRY_INSTALLED_KEY,
    },
  );
}

export async function expectNoRenderTelemetryErrors(
  page: Page,
  label: string,
): Promise<void> {
  const errors = await page.evaluate<RenderTelemetryIssue[]>((errorsKey) => {
    const value = (window as Window & Record<string, unknown>)[errorsKey];
    return Array.isArray(value) ? (value as RenderTelemetryIssue[]) : [];
  }, RENDER_TELEMETRY_ERRORS_KEY);
  const summary = errors
    .map(
      (event) =>
        `${event.name ?? "unknown"}:${event.renderCount ?? "?"} renders/${event.windowMs ?? "?"}ms`,
    )
    .join(", ");
  expect(
    errors,
    `[playwright-ui-smoke] ${label}: render telemetry errors detected${summary ? ` (${summary})` : ""}`,
  ).toHaveLength(0);
}

async function expectRootReady(page: Page): Promise<void> {
  await expect(page.locator("#root")).toBeVisible({ timeout: ROOT_TIMEOUT_MS });
}

async function expectNoFirstRunRedirect(page: Page): Promise<void> {
  await expect(page).not.toHaveURL(/first-run/, { timeout: NAV_TIMEOUT_MS });
}

async function expectStartupSettled(page: Page): Promise<void> {
  await page
    .getByText("Initializing agent")
    .waitFor({ state: "hidden", timeout: STARTUP_SETTLED_TIMEOUT_MS });
}

function isRootTargetPath(targetPath: string): boolean {
  try {
    const url = new URL(targetPath, "http://ui-smoke.local");
    return url.pathname === "/";
  } catch {
    return targetPath === "/" || targetPath.startsWith("/?");
  }
}

async function expectMainShellReadyForRoute(
  page: Page,
  targetPath: string,
): Promise<void> {
  if (isRootTargetPath(targetPath)) return;
  await expect(page.getByTestId("startup-shell-loading")).toHaveCount(0, {
    timeout: STARTUP_SETTLED_TIMEOUT_MS,
  });
  await expect(page.getByTestId("first-run-shell")).toHaveCount(0, {
    timeout: STARTUP_SETTLED_TIMEOUT_MS,
  });
}

async function replayNavigationAfterStartup(page: Page): Promise<void> {
  await page.evaluate(() => {
    const isAppWindowRoute = new URLSearchParams(window.location.search).get(
      "appWindow",
    );
    if (window.location.protocol === "file:" || isAppWindowRoute === "1") {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      return;
    }
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

export async function openAppPath(
  page: Page,
  targetPath: string,
): Promise<void> {
  await installRenderTelemetryGuard(page);
  await page.goto(targetPath, { waitUntil: "domcontentloaded" });
  await expectRootReady(page);
  await expectStartupSettled(page);
  await expectNoFirstRunRedirect(page);
  await expectMainShellReadyForRoute(page, targetPath);
  await replayNavigationAfterStartup(page);
  await expectNoRenderTelemetryErrors(page, targetPath);
}

export async function readLocalStorage(
  page: Page,
  key: string,
): Promise<string | null> {
  return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

export async function openSettingsSection(
  page: Page,
  sectionName: string | RegExp,
): Promise<void> {
  const settingsShell = page.getByTestId("settings-shell");
  if (!(await locatorVisible(settingsShell, 2_000))) {
    await replayNavigationAfterStartup(page);
  }
  await expect(settingsShell).toBeVisible({ timeout: READY_CHECK_TIMEOUT_MS });

  const settingsNav = page.getByRole("navigation", { name: "Settings" });
  const sectionButton = settingsNav.getByRole("button", { name: sectionName });
  if (await locatorVisible(sectionButton, 1_000)) {
    await sectionButton.click();
    return;
  }

  const sectionId = settingsSectionIdFromLabel(sectionName);
  if (sectionId) {
    const section = page.locator(`#${sectionId}`);
    await section.scrollIntoViewIfNeeded({ timeout: READY_CHECK_TIMEOUT_MS });
    await expect(section).toBeVisible({ timeout: READY_CHECK_TIMEOUT_MS });
    return;
  }

  const sectionHeading = settingsShell.getByText(sectionName).filter({
    visible: true,
  });
  await sectionHeading
    .first()
    .scrollIntoViewIfNeeded({ timeout: READY_CHECK_TIMEOUT_MS });
  await expect(sectionHeading.first()).toBeVisible({
    timeout: READY_CHECK_TIMEOUT_MS,
  });
}

function settingsSectionIdFromLabel(
  sectionName: string | RegExp,
): string | null {
  if (typeof sectionName === "string") {
    return SETTINGS_SECTION_IDS_BY_LABEL.get(sectionName) ?? null;
  }
  for (const [label, id] of SETTINGS_SECTION_IDS_BY_LABEL.entries()) {
    if (sectionName.test(label)) return id;
  }
  return null;
}

async function locatorVisible(
  locator: Locator,
  timeoutMs: number = READY_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

function formatReadyCheck(check: ReadyCheck): string {
  if ("selector" in check) {
    return `selector=${check.selector}`;
  }
  return `text=${JSON.stringify(check.text)}`;
}

function readyChecksPassed(
  results: EvaluatedReadyCheck[],
  mode: "any" | "all",
): boolean {
  if (mode === "all") {
    return results.every((result) => result.passed);
  }
  return results.some((result) => result.passed);
}

async function evaluateReadyChecks(
  page: Page,
  checks: readonly ReadyCheck[],
  mode: "any" | "all" = "any",
  timeoutMs: number = READY_CHECK_TIMEOUT_MS,
): Promise<{
  passed: boolean;
  results: EvaluatedReadyCheck[];
}> {
  const results: EvaluatedReadyCheck[] = [];

  for (const check of checks) {
    if ("selector" in check) {
      results.push({
        check,
        passed: await locatorVisible(page.locator(check.selector), timeoutMs),
      });
      continue;
    }
    results.push({
      check,
      passed: await locatorVisible(page.getByText(check.text), timeoutMs),
    });
  }

  return {
    passed: readyChecksPassed(results, mode),
    results,
  };
}

export async function assertReadyChecks(
  page: Page,
  label: string,
  checks: readonly ReadyCheck[],
  mode: "any" | "all" = "any",
  timeoutMs: number = READY_CHECK_TIMEOUT_MS,
): Promise<void> {
  let evaluation = await evaluateReadyChecks(page, checks, mode, timeoutMs);
  if (!evaluation.passed) {
    await replayNavigationAfterStartup(page);
    evaluation = await evaluateReadyChecks(page, checks, mode, timeoutMs);
  }
  const summary = evaluation.results
    .map(
      (result) =>
        `${result.passed ? "pass" : "fail"}:${formatReadyCheck(result.check)}`,
    )
    .join(", ");

  expect(
    evaluation.passed,
    `[playwright-ui-smoke] ${label}: ready checks failed (${summary})`,
  ).toBe(true);
}

function emptyWalletMarketSource(providerId: "coingecko" | "polymarket") {
  return {
    providerId,
    providerName: providerId === "coingecko" ? "CoinGecko" : "Polymarket",
    providerUrl:
      providerId === "coingecko"
        ? "https://www.coingecko.com"
        : "https://polymarket.com",
    available: false,
    stale: false,
    error: null,
  };
}

function emptyWalletMarketOverview() {
  return {
    generatedAt: SMOKE_GENERATED_AT,
    cacheTtlSeconds: 60,
    stale: false,
    sources: {
      prices: emptyWalletMarketSource("coingecko"),
      movers: emptyWalletMarketSource("coingecko"),
      predictions: emptyWalletMarketSource("polymarket"),
    },
    prices: [],
    movers: [],
    predictions: [],
  };
}

function emptyWalletTradingProfile(url: URL) {
  return {
    window: url.searchParams.get("window") ?? "30d",
    source: url.searchParams.get("source") ?? "all",
    generatedAt: SMOKE_GENERATED_AT,
    summary: {
      totalSwaps: 0,
      buyCount: 0,
      sellCount: 0,
      settledCount: 0,
      successCount: 0,
      revertedCount: 0,
      tradeWinRate: null,
      txSuccessRate: null,
      winningTrades: 0,
      evaluatedTrades: 0,
      realizedPnlBnb: "0",
      volumeBnb: "0",
    },
    pnlSeries: [],
    tokenBreakdown: [],
    recentSwaps: [],
  };
}

function smokeHyperliquidStatus() {
  return {
    publicReadReady: true,
    signerReady: false,
    executionReady: false,
    executionBlockedReason:
      "Signed Hyperliquid execution is disabled in UI smoke.",
    accountAddress: "0x1234567890abcdef1234567890abcdef12345678",
    apiBaseUrl: "https://api.hyperliquid.xyz",
    credentialMode: "none",
    readiness: {
      publicReads: true,
      accountReads: true,
      signer: false,
      execution: false,
    },
    account: {
      address: "0x1234567890abcdef1234567890abcdef12345678",
      source: "env_account",
      guidance: null,
    },
    vault: {
      configured: false,
      ready: false,
      address: null,
      guidance: "UI smoke uses deterministic read-only data.",
    },
    apiWallet: {
      configured: false,
      guidance: "UI smoke does not configure an API wallet.",
    },
  };
}

function smokeHyperliquidMarkets() {
  return {
    markets: [
      {
        name: "BTC",
        index: 0,
        szDecimals: 5,
        maxLeverage: 50,
        onlyIsolated: false,
        isDelisted: false,
      },
      {
        name: "ETH",
        index: 1,
        szDecimals: 4,
        maxLeverage: 25,
        onlyIsolated: false,
        isDelisted: false,
      },
    ],
    source: "hyperliquid-info-meta",
    fetchedAt: SMOKE_GENERATED_AT,
  };
}

function smokePolymarketStatus() {
  return {
    publicReads: {
      ready: true,
      reason: null,
      gammaApiBase: "https://gamma-api.polymarket.com",
      dataApiBase: "https://data-api.polymarket.com",
    },
    trading: {
      ready: false,
      reason: "Signed CLOB trading is disabled in UI smoke.",
      credentialsReady: false,
      missing: [
        "POLYMARKET_PRIVATE_KEY",
        "CLOB_API_KEY",
        "CLOB_API_SECRET",
        "CLOB_API_PASSPHRASE",
      ],
      clobApiBase: "https://clob.polymarket.com",
    },
  };
}

function smokePolymarketMarkets() {
  return {
    markets: [
      {
        id: "ui-smoke-green",
        slug: "ui-smoke-suite-green",
        question: "Will the UI smoke suite stay green?",
        description: "Deterministic market fixture for route coverage.",
        category: "Testing",
        active: true,
        closed: false,
        archived: false,
        restricted: false,
        enableOrderBook: true,
        conditionId: "0xpolymarketuismoke",
        clobTokenIds: ["yes-token", "no-token"],
        outcomes: [
          { name: "Yes", price: "0.87" },
          { name: "No", price: "0.13" },
        ],
        liquidity: "$12,345",
        volume: "$45,678",
        volume24hr: "$1,234",
        lastTradePrice: "0.87",
        bestBid: "0.86",
        bestAsk: "0.88",
        image: null,
        icon: null,
        endDate: "2026-06-01T00:00:00.000Z",
        startDate: SMOKE_GENERATED_AT,
        updatedAt: SMOKE_GENERATED_AT,
      },
      {
        id: "ui-smoke-secondary",
        slug: "ui-smoke-secondary-market",
        question: "Will fixture market selection work?",
        description: "Second deterministic market for click selection.",
        category: "Testing",
        active: true,
        closed: false,
        archived: false,
        restricted: false,
        enableOrderBook: true,
        conditionId: "0xpolymarketuismoke2",
        clobTokenIds: ["up-token", "down-token"],
        outcomes: [
          { name: "Up", price: "0.64" },
          { name: "Down", price: "0.36" },
        ],
        liquidity: "$2,345",
        volume: "$5,678",
        volume24hr: "$234",
        lastTradePrice: "0.64",
        bestBid: "0.63",
        bestAsk: "0.65",
        image: null,
        icon: null,
        endDate: "2026-06-02T00:00:00.000Z",
        startDate: SMOKE_GENERATED_AT,
        updatedAt: SMOKE_GENERATED_AT,
      },
    ],
    source: { api: "gamma", endpoint: "/markets" },
  };
}

function smokeShopifyProducts(url: URL) {
  const products = [
    {
      id: "gid://shopify/Product/1001",
      title: "Milady Hoodie",
      status: "ACTIVE",
      productType: "Apparel",
      vendor: "Eliza Smoke Store",
      totalInventory: 12,
      priceRange: { min: "88.00", max: "88.00" },
      imageUrl: null,
      updatedAt: SMOKE_GENERATED_AT,
    },
    {
      id: "gid://shopify/Product/1002",
      title: "Agent Sticker Pack",
      status: "DRAFT",
      productType: "Accessories",
      vendor: "Eliza Smoke Store",
      totalInventory: 4,
      priceRange: { min: "12.00", max: "18.00" },
      imageUrl: null,
      updatedAt: SMOKE_GENERATED_AT,
    },
  ];
  const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const filtered = query
    ? products.filter((product) => product.title.toLowerCase().includes(query))
    : products;
  return {
    products: filtered,
    total: filtered.length,
    page: Number(url.searchParams.get("page") ?? 1),
    pageSize: Number(url.searchParams.get("limit") ?? 20),
  };
}

function smokeShopifyOrders() {
  return {
    orders: [
      {
        id: "gid://shopify/Order/2001",
        name: "#1001",
        email: "buyer@example.test",
        totalPrice: "88.00",
        currencyCode: "USD",
        fulfillmentStatus: "UNFULFILLED",
        financialStatus: "PAID",
        createdAt: SMOKE_GENERATED_AT,
        lineItemCount: 1,
      },
    ],
    total: 1,
  };
}

function smokeShopifyInventory() {
  return {
    items: [
      {
        id: "gid://shopify/InventoryItem/3001",
        sku: "MLDY-HOODIE",
        productTitle: "Milady Hoodie",
        variantTitle: "Black / M",
        locationId: "gid://shopify/Location/1",
        locationName: "Main Warehouse",
        available: 3,
        incoming: 5,
      },
      {
        id: "gid://shopify/InventoryItem/3002",
        sku: "AGENT-STICKERS",
        productTitle: "Agent Sticker Pack",
        variantTitle: "",
        locationId: "gid://shopify/Location/1",
        locationName: "Main Warehouse",
        available: 12,
        incoming: 0,
      },
    ],
    locations: ["Main Warehouse"],
  };
}

function smokeShopifyCustomers(url: URL) {
  const customers = [
    {
      id: "gid://shopify/Customer/4001",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.test",
      ordersCount: 3,
      totalSpent: "264.00",
      currencyCode: "USD",
      createdAt: SMOKE_GENERATED_AT,
    },
    {
      id: "gid://shopify/Customer/4002",
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.test",
      ordersCount: 1,
      totalSpent: "88.00",
      currencyCode: "USD",
      createdAt: SMOKE_GENERATED_AT,
    },
  ];
  const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const filtered = query
    ? customers.filter((customer) =>
        `${customer.firstName} ${customer.lastName} ${customer.email}`
          .toLowerCase()
          .includes(query),
      )
    : customers;
  return { customers: filtered, total: filtered.length };
}

function smokeWalletBalances() {
  return {
    evm: {
      address: "0x1234567890abcdef1234567890abcdef12345678",
      chains: [
        {
          chain: "ethereum",
          chainId: 1,
          nativeBalance: "0.25",
          nativeSymbol: "ETH",
          nativeValueUsd: "900.00",
          tokens: [
            {
              contractAddress: null,
              symbol: "USDC",
              name: "USD Coin",
              balance: "125.50",
              decimals: 6,
              valueUsd: "125.50",
              logoUrl: "",
            },
          ],
          error: null,
        },
      ],
    },
    solana: {
      address: "So11111111111111111111111111111111111111112",
      solBalance: "3.5",
      solValueUsd: "525.00",
      tokens: [],
    },
  };
}

function smokeWalletConfig() {
  return {
    configured: true,
    evmConfigured: true,
    solanaConfigured: true,
    evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
    solanaAddress: "So11111111111111111111111111111111111111112",
    evmBalanceReady: true,
    solanaBalanceReady: true,
    walletNetwork: "mainnet",
    selectedRpcProviders: {
      evm: "publicnode",
      bsc: "publicnode",
      solana: "publicnode",
    },
    wallets: [
      {
        chain: "evm",
        source: "local",
        address: "0x1234567890abcdef1234567890abcdef12345678",
        label: "Smoke EVM",
      },
      {
        chain: "solana",
        source: "local",
        address: "So11111111111111111111111111111111111111112",
        label: "Smoke Solana",
      },
    ],
    primary: {
      evm: "local",
      solana: "local",
    },
    warnings: [],
  };
}

function smokeWalletNfts() {
  return {
    evm: [
      {
        chain: "ethereum",
        contractAddress: "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
        collectionName: "Eliza Smoke Collection",
        nfts: [
          {
            tokenId: "42",
            name: "Smoke Test NFT #42",
            collectionName: "Eliza Smoke Collection",
            imageUrl: "",
            tokenUri: "",
          },
        ],
      },
    ],
    solana: {
      nfts: [
        {
          mint: "Smoke111111111111111111111111111111111111111",
          name: "Smoke Solana Collectible",
          collectionName: "Eliza Smoke Collection",
          imageUrl: "",
          tokenUri: "",
        },
      ],
    },
  };
}

function smokeVincentStrategy(connected: boolean) {
  return {
    connected,
    strategy: connected
      ? {
          name: "threshold",
          venues: ["hyperliquid", "polymarket"],
          params: { maxPositionUsd: 250, rebalanceThreshold: "5%" },
          intervalSeconds: 900,
          dryRun: true,
          running: true,
        }
      : null,
  };
}

function smokeVincentTradingProfile(connected: boolean) {
  return {
    connected,
    profile: connected
      ? {
          totalPnl: "+$42.00",
          winRate: 0.625,
          totalSwaps: 8,
          volume24h: "$1,234.00",
          tokenBreakdown: [
            { symbol: "BTC", pnl: "+$30.00", swaps: 5 },
            { symbol: "ETH", pnl: "+$12.00", swaps: 3 },
          ],
        }
      : null,
  };
}

const EMPTY_LIFEOPS_OVERVIEW_SUMMARY = {
  activeOccurrenceCount: 0,
  overdueOccurrenceCount: 0,
  snoozedOccurrenceCount: 0,
  activeReminderCount: 0,
  activeGoalCount: 0,
};

const EMPTY_LIFEOPS_CHANNEL_COUNTS = {
  gmail: { total: 0, unread: 0 },
  discord: { total: 0, unread: 0 },
  telegram: { total: 0, unread: 0 },
  signal: { total: 0, unread: 0 },
  imessage: { total: 0, unread: 0 },
  whatsapp: { total: 0, unread: 0 },
  sms: { total: 0, unread: 0 },
  x_dm: { total: 0, unread: 0 },
};

function emptyLifeOpsOverview() {
  const section = {
    occurrences: [],
    goals: [],
    reminders: [],
    summary: EMPTY_LIFEOPS_OVERVIEW_SUMMARY,
  };
  return {
    occurrences: [],
    goals: [],
    reminders: [],
    summary: EMPTY_LIFEOPS_OVERVIEW_SUMMARY,
    owner: section,
    agentOps: section,
    schedule: null,
  };
}

function emptyLifeOpsSocialSummary(url: URL) {
  return {
    since: url.searchParams.get("since") ?? SMOKE_GENERATED_AT,
    until: url.searchParams.get("until") ?? SMOKE_GENERATED_AT,
    totalSeconds: 0,
    services: [],
    devices: [],
    surfaces: [],
    browsers: [],
    sessions: [],
    messages: {
      channels: [],
      inbound: 0,
      outbound: 0,
      opened: 0,
      replied: 0,
    },
    dataSources: [],
    fetchedAt: SMOKE_GENERATED_AT,
  };
}

function emptyTrainingStatus() {
  return {
    runningJobs: 0,
    queuedJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    modelCount: 0,
    datasetCount: 0,
    runtimeAvailable: false,
  };
}

function emptyTrainingCollections() {
  return {
    root: "/tmp/eliza-ui-smoke-training",
    indexJsonPath: "/tmp/eliza-ui-smoke-training/index.json",
    indexHtmlPath: "/tmp/eliza-ui-smoke-training/index.html",
    collections: [],
  };
}

function emptyStewardStatus() {
  return {
    configured: true,
    available: true,
    connected: true,
    error: null,
    baseUrl: "https://steward.smoke.test",
    agentId: "ui-smoke-agent",
    agentName: "UI Smoke Agent",
    walletAddresses: {
      evm: "0x1234567890abcdef1234567890abcdef12345678",
      solana: "So11111111111111111111111111111111111111112",
    },
    evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
    solanaAddress: "So11111111111111111111111111111111111111112",
    vaultHealth: "ok",
  };
}

function smokeStewardTxRecord(
  id: string,
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "signed"
    | "broadcast"
    | "confirmed"
    | "failed",
  overrides: {
    chainId?: number;
    createdAt?: string;
    to?: string;
    txHash?: string;
    value?: string;
  } = {},
) {
  return {
    id,
    agentId: "ui-smoke-agent",
    status,
    request: {
      agentId: "ui-smoke-agent",
      tenantId: "ui-smoke-tenant",
      to:
        overrides.to ??
        (id.endsWith("two")
          ? "0xfeed00000000000000000000000000000000beef"
          : "0xc0ffee00000000000000000000000000000000cafe"),
      value: overrides.value ?? "10000000000000000",
      data: "0x",
      chainId: overrides.chainId ?? 8453,
    },
    txHash: overrides.txHash,
    policyResults:
      status === "pending"
        ? [
            {
              policy: "manual-approval",
              status: "pending",
              reason: "Manual approval required for UI smoke.",
            },
          ]
        : [],
    createdAt: overrides.createdAt ?? SMOKE_GENERATED_AT,
    signedAt:
      status === "signed" || status === "broadcast" || status === "confirmed"
        ? "2026-01-01T00:01:00.000Z"
        : undefined,
    confirmedAt:
      status === "confirmed" ? "2026-01-01T00:02:00.000Z" : undefined,
  };
}

function smokeStewardPendingApprovals() {
  return [
    {
      queueId: "queue-smoke-one",
      status: "pending",
      requestedAt: SMOKE_GENERATED_AT,
      transaction: smokeStewardTxRecord("tx-smoke-one", "pending"),
    },
    {
      queueId: "queue-smoke-two",
      status: "pending",
      requestedAt: "2026-01-01T00:03:00.000Z",
      transaction: smokeStewardTxRecord("tx-smoke-two", "pending", {
        chainId: 56,
        createdAt: "2026-01-01T00:03:00.000Z",
        value: "25000000000000000",
      }),
    },
  ];
}

function smokeStewardHistoryRecords() {
  return [
    smokeStewardTxRecord("tx-smoke-confirmed", "confirmed", {
      createdAt: "2026-01-01T00:05:00.000Z",
      txHash:
        "0xabc1230000000000000000000000000000000000000000000000000000000000",
    }),
    smokeStewardTxRecord("tx-smoke-history-pending", "pending", {
      chainId: 56,
      createdAt: "2026-01-01T00:04:00.000Z",
      to: "0xfeed00000000000000000000000000000000beef",
    }),
  ];
}

/** Installs baseline API routes for smoke tests before flow-specific overrides. */
export async function installDefaultAppRoutes(page: Page): Promise<void> {
  await page.route(/\/(?:brand|app-heroes)\//, async (route) => {
    if (await fulfillPublicAsset(route)) return;
    await route.fallback();
  });

  // VRM assets (vrms/<slug>.vrm.gz + vrms/previews|backgrounds/<slug>.png) —
  // the preview server doesn't carry the runtime boot-config's vrmAssets, so
  // resolveAppAssetUrl(`vrms/...`) 404s. Serve a real bundled VRM (so the
  // companion canvas renders a model) and a 1×1 PNG for the preview/background
  // thumbnails (the canvas falls back if those are absent, but a 404 still
  // shows as a console error). Match `**/vrms/**` to catch any sub-path.
  await page.route("**/vrms/**", async (route) => {
    const url = route.request().url();
    if (/\.vrm(\.gz)?(\?|$)/i.test(url)) {
      const body = bundledVrmGz();
      if (!body) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body,
      });
      return;
    }
    if (/\.png(\?|$)/i.test(url)) {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "image/png" },
        body: ONE_PX_PNG,
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    "https://raw.githubusercontent.com/trustwallet/**",
    async (route) => {
      if (/\.(?:png|jpe?g|webp|gif|svg)(?:\?|$)/i.test(route.request().url())) {
        await route.fulfill({
          status: 200,
          contentType: "image/png",
          body: ONE_PX_PNG,
        });
        return;
      }
      await route.fallback();
    },
  );

  await page.route("**/api/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: "running",
        agentName: "Playwright Smoke",
        model: "ui-smoke",
        startedAt: Date.parse(SMOKE_GENERATED_AT),
        uptime: 60_000,
      }),
    });
  });

  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ complete: true, cloudProvisioned: true }),
    });
  });

  await page.route("**/api/asr/local-inference/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ready: false }),
    });
  });

  await page.route("**/api/hyperliquid/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokeHyperliquidStatus()),
    });
  });

  await page.route("**/api/hyperliquid/markets", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokeHyperliquidMarkets()),
    });
  });

  await page.route("**/api/hyperliquid/positions", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accountAddress: smokeHyperliquidStatus().accountAddress,
        positions: [
          {
            coin: "BTC",
            size: "0.05",
            entryPx: "65000",
            positionValue: "3250",
            unrealizedPnl: "42",
            returnOnEquity: "0.012",
            liquidationPx: null,
            marginUsed: "650",
            leverageType: "cross",
            leverageValue: 5,
          },
        ],
        readBlockedReason: null,
        fetchedAt: SMOKE_GENERATED_AT,
      }),
    });
  });

  await page.route("**/api/hyperliquid/orders", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accountAddress: smokeHyperliquidStatus().accountAddress,
        orders: [
          {
            coin: "ETH",
            side: "B",
            limitPx: "3200",
            size: "0.25",
            oid: 1001,
            timestamp: Date.parse(SMOKE_GENERATED_AT),
            reduceOnly: false,
            orderType: "Limit",
            tif: "Gtc",
            cloid: null,
          },
        ],
        readBlockedReason: null,
        fetchedAt: SMOKE_GENERATED_AT,
      }),
    });
  });

  await page.route("**/api/polymarket/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokePolymarketStatus()),
    });
  });

  await page.route("**/api/polymarket/markets**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokePolymarketMarkets()),
    });
  });

  await page.route("**/api/polymarket/orders", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: false,
        reason: "Signed CLOB trading is disabled in UI smoke.",
        requiredForTrading: [
          "POLYMARKET_PRIVATE_KEY",
          "CLOB_API_KEY",
          "CLOB_API_SECRET",
          "CLOB_API_PASSPHRASE",
        ],
      }),
    });
  });

  await page.route("**/api/polymarket/positions**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        positions: [],
        source: { api: "data", endpoint: "/positions" },
      }),
    });
  });

  await page.route("**/api/shopify/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: true,
        shop: {
          name: "Eliza Smoke Store",
          domain: "smoke-store.example",
          plan: "development",
          email: "ops@example.test",
          currencyCode: "USD",
        },
      }),
    });
  });

  await page.route("**/api/shopify/products**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(smokeShopifyProducts(new URL(request.url()))),
      });
      return;
    }
    if (request.method() === "POST") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, productId: "ui-smoke-product" }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/shopify/orders**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokeShopifyOrders()),
    });
  });

  await page.route("**/api/shopify/inventory", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokeShopifyInventory()),
    });
  });

  await page.route("**/api/shopify/inventory/**/adjust", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/shopify/customers**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        smokeShopifyCustomers(new URL(route.request().url())),
      ),
    });
  });

  let vincentConnected = true;
  const vincentConnectedAt = Date.parse(SMOKE_GENERATED_AT);

  await page.route("**/api/vincent/status**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: vincentConnected,
        connectedAt: vincentConnected ? vincentConnectedAt : null,
        tradingVenues: vincentConnected ? ["hyperliquid", "polymarket"] : [],
      }),
    });
  });

  await page.route("**/api/vincent/start-login", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    vincentConnected = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authUrl: "https://heyvincent.ai/ui-smoke-auth",
        state: "ui-smoke",
        redirectUri: "http://127.0.0.1/callback/vincent",
      }),
    });
  });

  await page.route("**/api/vincent/disconnect", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    vincentConnected = false;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/vincent/strategy", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(smokeVincentStrategy(vincentConnected)),
      });
      return;
    }
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, ...smokeVincentStrategy(true) }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/vincent/trading-profile", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokeVincentTradingProfile(vincentConnected)),
    });
  });

  await page.route("**/api/wallet/config", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokeWalletConfig()),
    });
  });

  await page.route("**/api/wallet/addresses", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
        solanaAddress: "So11111111111111111111111111111111111111112",
      }),
    });
  });

  await page.route("**/api/wallet/balances", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokeWalletBalances()),
    });
  });

  await page.route("**/api/wallet/nfts", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(smokeWalletNfts()),
    });
  });

  await page.route("**/api/model-tester/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tests: [
          {
            id: "text-small",
            label: "Text",
            modelType: "TEXT_SMALL",
            available: true,
            providers: ["deterministic-ui-smoke"],
          },
          {
            id: "text-large",
            label: "Streaming Text",
            modelType: "TEXT_LARGE",
            available: true,
            providers: ["deterministic-ui-smoke"],
          },
          {
            id: "embedding",
            label: "Embedding",
            modelType: "TEXT_EMBEDDING",
            available: true,
            providers: ["deterministic-ui-smoke"],
          },
          {
            id: "text-to-speech",
            label: "Voice",
            modelType: "TEXT_TO_SPEECH",
            available: true,
            providers: ["deterministic-ui-smoke"],
          },
          {
            id: "transcription",
            label: "Transcription",
            modelType: "TRANSCRIPTION",
            available: true,
            providers: ["deterministic-ui-smoke"],
          },
          {
            id: "vad",
            label: "Voice Activity",
            modelType: "TEXT_SMALL",
            available: true,
            providers: ["deterministic-ui-smoke"],
          },
          {
            id: "image-description",
            label: "Image Description",
            modelType: "IMAGE_DESCRIPTION",
            available: true,
            providers: ["deterministic-ui-smoke"],
          },
          {
            id: "image",
            label: "Image Generation",
            modelType: "IMAGE",
            available: true,
            providers: ["deterministic-ui-smoke"],
          },
        ],
      }),
    });
  });

  await page.route("**/api/model-tester/run", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const rawBody = route.request().postData() ?? "{}";
    const body = JSON.parse(rawBody) as { test?: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        test: body.test ?? "text-small",
        durationMs: 1,
        output: {
          text: "deterministic model tester result",
        },
      }),
    });
  });

  const orchestratorUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    state: "unavailable",
    byProvider: [],
  };
  await page.route("**/api/orchestrator/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        taskCount: 0,
        activeTaskCount: 0,
        pausedTaskCount: 0,
        blockedTaskCount: 0,
        validatingTaskCount: 0,
        sessionCount: 0,
        activeSessionCount: 0,
        usage: orchestratorUsage,
        byStatus: {
          open: 0,
          active: 0,
          waiting_on_user: 0,
          blocked: 0,
          validating: 0,
          done: 0,
          failed: 0,
          archived: 0,
          interrupted: 0,
        },
      }),
    });
  });

  await page.route("**/api/orchestrator/tasks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === "/api/orchestrator/tasks"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tasks: [] }),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/messages")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/events")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/usage")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(orchestratorUsage),
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        required: false,
        authenticated: true,
        loginRequired: false,
        localAccess: true,
        passwordConfigured: true,
        pairingEnabled: false,
        expiresAt: null,
      }),
    });
  });

  await page.route("**/api/auth/me", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        identity: {
          id: "playwright-smoke-owner",
          displayName: "Playwright Smoke",
          kind: "owner",
        },
        session: {
          id: "playwright-smoke-session",
          kind: "local",
          expiresAt: null,
        },
        access: {
          mode: "local",
          passwordConfigured: false,
          ownerConfigured: true,
        },
      }),
    });
  });

  await page.route("**/api/auth/sessions", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [] }),
    });
  });

  await page.route("**/api/agents", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agents: [] }),
    });
  });

  await page.route("**/api/connectors/google/accounts", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "google",
        connectorId: "google",
        defaultAccountId: null,
        accounts: [],
      }),
    });
  });

  await page.route("**/api/lifeops/app-state", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        priorityScoring: {
          enabled: true,
          model: null,
        },
      }),
    });
  });

  await page.route(
    "**/api/lifeops/connectors/google/status**",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          connected: false,
          available: false,
          authUrl: null,
          lastSyncedAt: null,
        }),
      });
    },
  );

  await page.route("**/api/lifeops/connectors/x/status**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "x",
        side: "owner",
        mode: "local",
        defaultMode: "local",
        availableModes: ["local"],
        configured: false,
        connected: false,
        reason: "disconnected",
        preferredByAgent: false,
        cloudConnectionId: null,
        grantedCapabilities: [],
        grantedScopes: [],
        identity: null,
        hasCredentials: false,
        feedRead: false,
        feedWrite: false,
        dmRead: false,
        dmWrite: false,
        dmInbound: false,
        grant: null,
      }),
    });
  });

  await page.route("**/api/lifeops/capabilities", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: SMOKE_GENERATED_AT,
        appEnabled: true,
        relativeTime: null,
        capabilities: [],
        summary: {
          totalCount: 0,
          workingCount: 0,
          degradedCount: 0,
          blockedCount: 0,
          notConfiguredCount: 0,
        },
      }),
    });
  });

  await page.route("**/api/lifeops/overview", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyLifeOpsOverview()),
    });
  });

  await page.route("**/api/lifeops/definitions", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: method === "POST" ? 201 : 200,
      contentType: "application/json",
      body: JSON.stringify({ definitions: [] }),
    });
  });

  await page.route("**/api/lifeops/calendar/feed**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(request.url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        calendarId: "primary",
        events: [],
        source: "cache",
        timeMin: url.searchParams.get("timeMin") ?? SMOKE_GENERATED_AT,
        timeMax: url.searchParams.get("timeMax") ?? SMOKE_GENERATED_AT,
        syncedAt: null,
      }),
    });
  });

  await page.route("**/api/lifeops/inbox**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [],
        channelCounts: EMPTY_LIFEOPS_CHANNEL_COUNTS,
        threadGroups: [],
        fetchedAt: SMOKE_GENERATED_AT,
      }),
    });
  });

  await page.route("**/api/lifeops/screen-time/summary**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], totalSeconds: 0 }),
    });
  });

  await page.route("**/api/lifeops/screen-time/breakdown**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [],
        totalSeconds: 0,
        bySource: [],
        byCategory: [],
        byDevice: [],
        byService: [],
        byBrowser: [],
        fetchedAt: SMOKE_GENERATED_AT,
      }),
    });
  });

  await page.route("**/api/lifeops/screen-time/history**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], totalSeconds: 0 }),
    });
  });

  await page.route("**/api/lifeops/social/summary**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyLifeOpsSocialSummary(new URL(request.url()))),
    });
  });

  await page.route("**/api/lifeops/sleep/history**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ entries: [], items: [] }),
    });
  });

  await page.route("**/api/lifeops/sleep/regularity**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        score: null,
        items: [],
        generatedAt: SMOKE_GENERATED_AT,
      }),
    });
  });

  await page.route("**/api/lifeops/sleep/baseline**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ baseline: null, generatedAt: SMOKE_GENERATED_AT }),
    });
  });

  await page.route("**/api/lifeops/activity-signals**", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "POST" && method !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: method === "POST" ? 201 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        method === "POST" ? { signal: null } : { signals: [] },
      ),
    });
  });

  await page.route("**/api/lifeops/schedule/merged-state**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ occurrences: [], goals: [], reminders: [] }),
    });
  });

  await page.route("**/api/lifeops/smart-features/settings", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: false,
        features: {},
        updatedAt: SMOKE_GENERATED_AT,
      }),
    });
  });

  await page.route("**/api/browser-bridge/settings", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        settings: {
          enabled: false,
          trackingMode: "off",
          pauseUntil: null,
          allowBrowserControl: false,
          siteAccessMode: "current_site_only",
          grantedOrigins: [],
          blockedOrigins: [],
        },
      }),
    });
  });

  await page.route("**/api/browser-bridge/companions", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ companions: [] }),
    });
  });

  await page.route("**/api/browser-bridge/packages", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ packages: [] }),
    });
  });

  await page.route("**/api/website-blocker", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: false, rules: [], activeBlocks: [] }),
    });
  });

  await page.route("**/api/automations/nodes", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        nodes: [],
        summary: { total: 0, enabled: 0, disabled: 0 },
      }),
    });
  });

  await page.route("**/api/cloud/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: false,
        enabled: false,
        cloudVoiceProxyAvailable: false,
        hasApiKey: false,
      }),
    });
  });

  await page.route("**/api/facewear/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ connected: false, devices: [] }),
    });
  });

  await page.route("**/api/training/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyTrainingStatus()),
    });
  });

  await page.route("**/api/training/trajectories**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: false,
        reason: "ui-smoke",
        total: 0,
        trajectories: [],
      }),
    });
  });

  await page.route("**/api/training/datasets", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ datasets: [] }),
    });
  });

  await page.route("**/api/training/backends**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        backends: { mlx: false, cuda: false, cpu: true },
      }),
    });
  });

  await page.route("**/api/training/jobs", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobs: [] }),
    });
  });

  await page.route("**/api/training/models", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ models: [] }),
    });
  });

  await page.route("**/api/training/vast/models", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ loaded_at: null, entries: [] }),
    });
  });

  await page.route("**/api/training/collections**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyTrainingCollections()),
    });
  });

  await page.route("**/api/training/auto/config", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        config: {
          autoTrain: false,
          triggerThreshold: 20,
          triggerCooldownHours: 24,
          backends: [],
        },
      }),
    });
  });

  await page.route("**/api/training/auto/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ serviceRegistered: false }),
    });
  });

  await page.route("**/api/training/auto/runs**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runs: [] }),
    });
  });

  await page.route("**/api/training/blueprints", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, stats: {}, blueprints: [] }),
    });
  });

  await page.route("**/api/training/context-catalog", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ contexts: [], actions: {}, providers: {} }),
    });
  });

  await page.route("**/api/training/context-audit", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ gaps: [], missingContexts: [], hasGaps: false }),
    });
  });

  await page.route("**/api/trajectories**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(request.url());
    if (url.pathname === "/api/trajectories/stats") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          totalTrajectories: 0,
          totalLlmCalls: 0,
          totalProviderAccesses: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          averageDurationMs: 0,
          bySource: {},
          byModel: {},
        }),
      });
      return;
    }
    if (url.pathname === "/api/trajectories/config") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: false }),
      });
      return;
    }
    if (url.pathname === "/api/trajectories/latest") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ trajectory: null }),
      });
      return;
    }
    if (url.pathname === "/api/trajectories") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          trajectories: [],
          total: 0,
          offset: Number(url.searchParams.get("offset") ?? 0),
          limit: Number(url.searchParams.get("limit") ?? 50),
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        trajectory: {
          id: decodeURIComponent(url.pathname.split("/").pop() ?? "unknown"),
          status: "completed",
          llmCallCount: 0,
        },
        llmCalls: [],
        providerAccesses: [],
        toolEvents: [],
        evaluationEvents: [],
      }),
    });
  });

  let stewardPendingApprovals = smokeStewardPendingApprovals();
  const stewardHistoryRecords = smokeStewardHistoryRecords();

  await page.route("**/api/wallet/steward-status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyStewardStatus()),
    });
  });

  await page.route("**/api/wallet/steward-pending-approvals", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(stewardPendingApprovals),
    });
  });

  await page.route("**/api/wallet/steward-tx-records**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(request.url());
    const status = url.searchParams.get("status");
    const records = status
      ? stewardHistoryRecords.filter((record) => record.status === status)
      : stewardHistoryRecords;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        records,
        total: records.length,
        offset: Number(url.searchParams.get("offset") ?? 0),
        limit: Number(url.searchParams.get("limit") ?? 25),
      }),
    });
  });

  await page.route("**/api/wallet/steward-approve-tx", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const rawBody = route.request().postData() ?? "{}";
    const body = JSON.parse(rawBody) as { txId?: string };
    stewardPendingApprovals = stewardPendingApprovals.filter(
      (approval) => approval.transaction.id !== body.txId,
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        txHash:
          "0xapproved000000000000000000000000000000000000000000000000000000",
      }),
    });
  });

  await page.route("**/api/wallet/steward-deny-tx", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const rawBody = route.request().postData() ?? "{}";
    const body = JSON.parse(rawBody) as { txId?: string };
    stewardPendingApprovals = stewardPendingApprovals.filter(
      (approval) => approval.transaction.id !== body.txId,
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/wallet/market-overview", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyWalletMarketOverview()),
    });
  });

  await page.route("**/api/wallet/trading/profile**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyWalletTradingProfile(new URL(request.url()))),
    });
  });
}

type CloudWalletImportMockApi = {
  lastWalletConfigPut: () => Record<string, unknown> | null;
  refreshCloudRequestCount: () => number;
  walletConfigGetCount: () => number;
};

/** Overrides the default smoke routes for the cloud wallet import flow. */
export async function installCloudWalletImportApiOverrides(
  page: Page,
): Promise<CloudWalletImportMockApi> {
  let lastWalletPut: Record<string, unknown> | null = null;
  let refreshCloudHits = 0;
  let walletConfigGetHits = 0;

  const initialWalletConfig = {
    selectedRpcProviders: {
      evm: "eliza-cloud",
      bsc: "eliza-cloud",
      solana: "eliza-cloud",
    },
    walletNetwork: "mainnet",
    legacyCustomChains: [],
    alchemyKeySet: true,
    infuraKeySet: false,
    ankrKeySet: false,
    nodeRealBscRpcSet: false,
    quickNodeBscRpcSet: false,
    managedBscRpcReady: false,
    cloudManagedAccess: true,
    heliusKeySet: true,
    birdeyeKeySet: false,
    evmChains: ["ethereum", "base"],
    evmAddress: null,
    solanaAddress: null,
  };

  let walletConfigState: typeof initialWalletConfig = {
    ...initialWalletConfig,
    legacyCustomChains: [...initialWalletConfig.legacyCustomChains],
    evmChains: [...initialWalletConfig.evmChains],
  };

  await page.route("**/api/cloud/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: true,
        enabled: true,
        cloudVoiceProxyAvailable: true,
        hasApiKey: true,
        userId: "playwright-smoke-user",
      }),
    });
  });

  await page.route("**/api/cloud/credits", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        balance: 100,
        low: false,
        critical: false,
        authRejected: false,
      }),
    });
  });

  await page.route("**/api/wallet/config", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      walletConfigGetHits += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(walletConfigState),
      });
      return;
    }
    if (req.method() === "PUT") {
      const raw = req.postData();
      lastWalletPut = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const selections = lastWalletPut?.selections as
        | typeof walletConfigState.selectedRpcProviders
        | undefined;
      if (selections) {
        walletConfigState = {
          ...walletConfigState,
          selectedRpcProviders: selections,
          cloudManagedAccess: true,
        };
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/wallet/refresh-cloud", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    refreshCloudHits += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        warnings: [],
      }),
    });
  });

  await page.route("**/api/wallet/addresses", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ evmAddress: null, solanaAddress: null }),
    });
  });

  await page.route("**/api/wallet/balances", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        evm: null,
        solana: null,
      }),
    });
  });

  await page.route("**/api/wallet/nfts", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ evm: [], solana: null }),
    });
  });

  return {
    lastWalletConfigPut: () => lastWalletPut,
    refreshCloudRequestCount: () => refreshCloudHits,
    walletConfigGetCount: () => walletConfigGetHits,
  };
}
