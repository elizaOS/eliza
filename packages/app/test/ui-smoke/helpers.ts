import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";

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

const ROOT_TIMEOUT_MS = 20_000;
const NAV_TIMEOUT_MS = 12_000;
// Ready checks only confirm route-level render markers after navigation.
// Full bootstrap waits use the surrounding test timeout and Playwright defaults.
const READY_CHECK_TIMEOUT_MS = 15_000;
const SMOKE_GENERATED_AT = "2026-01-01T00:00:00.000Z";
const STORAGE_SEEDED_KEY = "eliza:ui-smoke-storage-seeded";

type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

type EvaluatedReadyCheck = {
  check: ReadyCheck;
  passed: boolean;
};

const DEFAULT_APP_STORAGE: Record<string, string> = {
  "eliza:onboarding-complete": "1",
  "eliza:onboarding:step": "activate",
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

async function expectRootReady(page: Page): Promise<void> {
  await expect(page.locator("#root")).toBeVisible({ timeout: ROOT_TIMEOUT_MS });
}

async function expectNoOnboardingRedirect(page: Page): Promise<void> {
  await expect(page).not.toHaveURL(/onboarding/, { timeout: NAV_TIMEOUT_MS });
}

export async function openAppPath(
  page: Page,
  targetPath: string,
): Promise<void> {
  await page.goto(targetPath, { waitUntil: "domcontentloaded" });
  await expectRootReady(page);
  await expectNoOnboardingRedirect(page);
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
  const settingsNav = page.getByRole("navigation", { name: "Settings" });
  await settingsNav.getByRole("button", { name: sectionName }).click();
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
  const evaluation = await evaluateReadyChecks(page, checks, mode, timeoutMs);
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

/** Installs baseline API routes for smoke tests before flow-specific overrides. */
export async function installDefaultAppRoutes(page: Page): Promise<void> {
  // VRM model assets (vrms/<slug>.vrm.gz) — the preview server doesn't carry
  // the runtime boot-config's vrmAssets, so resolveAppAssetUrl(`vrms/...`)
  // 404s. Serve a real bundled VRM so the companion canvas renders without a
  // console error. previews/backgrounds PNGs are best-effort: a 404 there is
  // harmless (the canvas falls back), so leave those to fallback().
  await page.route("**/vrms/*.vrm.gz", async (route) => {
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
  });

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
