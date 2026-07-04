/**
 * Playwright UI-smoke spec for the Settings Background app flow using the real
 * renderer fixture.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import sharp from "sharp";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

// #9143 follow-up — Settings now uses the TRANSPARENT app shell so the unified
// AppBackground (the launcher wallpaper) shows through, including the
// status-bar safe area. Previously Settings painted an opaque `bg-bg` box that
// left a seam at the top safe area. This spec proves:
//   (a) the safe-area seam is gone — the Settings shell ancestor carries no
//       opaque `bg-bg`, so the fixed wallpaper is continuous to the top, and
//   (b) Settings is captured over BOTH the default shader background AND a busy
//       photo wallpaper, at desktop + mobile, for human readability review,
//   (c) a launcher-over-the-same-photo reference is captured so the Settings
//       look can be compared to the home look the user wants to match.

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "aesthetic-audit-output",
  "settings-background",
);

// A handful of launcher views so the launcher is non-empty (the home
// WidgetHost / catalog only renders content when the catalog has visible
// views — see ViewCatalog.tsx's empty-state branch).
const VIEW_FIXTURES = [
  {
    id: "views-manager",
    label: "Views",
    description: "Browse and launch every available view",
    path: "/views",
    available: true,
    pluginName: "core",
    builtin: true,
    tags: ["launcher"],
    desktopTabEnabled: true,
  },
  {
    id: "settings",
    label: "Settings",
    description: "Agent + app settings",
    path: "/settings",
    available: true,
    pluginName: "core",
    builtin: true,
    tags: ["settings"],
    desktopTabEnabled: true,
  },
  {
    id: "calendar",
    label: "Calendar",
    description: "Calendar view",
    path: "/calendar",
    available: true,
    pluginName: "calendar",
    tags: ["calendar"],
    desktopTabEnabled: true,
  },
];

// localStorage key for the persisted BackgroundConfig (persistence.ts
// UI_BACKGROUND_STORAGE_KEY). AppBackground reads this via useBackgroundConfig.
const UI_BACKGROUND_STORAGE_KEY = "eliza:ui-background";

async function fulfillJson(
  route: Route,
  body: Record<string, unknown> | unknown[],
): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * A busy "photo-like" wallpaper as a JPEG data URL: a multi-stop gradient with
 * scattered translucent circles/rects and bright text overlays. This is a worst
 * case for a flat (card-less) settings layout — the page has to stay legible
 * over real high-contrast variance, not a calm flat field. Generated in-test
 * with sharp (already a suite dependency) so no binary fixture is committed.
 */
async function busyWallpaperDataUrl(): Promise<string> {
  const W = 1280;
  const H = 900;
  const circles = Array.from({ length: 24 })
    .map(
      (_, i) =>
        `<circle cx="${(i * 127) % W}" cy="${(i * 211) % H}" r="${
          40 + ((i * 13) % 120)
        }" fill="rgba(255,255,255,${0.05 + (i % 5) * 0.06})"/>`,
    )
    .join("");
  const rects = Array.from({ length: 30 })
    .map(
      (_, i) =>
        `<rect x="${(i * 83) % W}" y="${(i * 167) % H}" width="${
          60 + ((i * 7) % 180)
        }" height="${30 + ((i * 11) % 90)}" fill="rgba(0,0,0,${
          0.04 + (i % 6) * 0.05
        })"/>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0b3d91"/>
        <stop offset="35%" stop-color="#11998e"/>
        <stop offset="60%" stop-color="#f6d365"/>
        <stop offset="100%" stop-color="#e84393"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    ${circles}
    ${rects}
    <text x="60" y="200" font-family="sans-serif" font-size="120" fill="rgba(255,255,255,0.85)">WALLPAPER</text>
    <text x="60" y="760" font-family="sans-serif" font-size="80" fill="rgba(0,0,0,0.5)">busy photo bg</text>
  </svg>`;
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 78 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

async function installSettingsBackgroundRoutes(page: Page): Promise<void> {
  await installDefaultAppRoutes(page);

  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      cloud: { enabled: false },
      media: {},
      plugins: { entries: {} },
      ui: { avatarIndex: 1 },
      wallet: {},
    });
  });

  await page.route("**/api/stream/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, { settings: { avatarIndex: 1 } });
  });
  await page.route("**/api/agent/events**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      events: [],
      latestEventId: null,
      totalBuffered: 0,
      replayed: true,
    });
  });

  // Local-inference shell-level GETs — the booted zero-key stack answers 501,
  // which the diagnostics guard treats as a failure. A fresh agent has no local
  // model, so an idle/unsupported snapshot matches real zero-state.
  await page.route("**/api/local-inference/hub", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const emptyDownload = {
      state: "idle",
      percent: null,
      etaMs: null,
      bytesDownloaded: 0,
      bytesTotal: 0,
      error: null,
    };
    const slot = (name: string) => ({
      slot: name,
      assigned: false,
      assignedModelId: null,
      displayName: null,
      primaryDownloaded: false,
      downloaded: false,
      active: false,
      ready: false,
      state: "unassigned",
      requiredModelIds: [],
      missingModelIds: [],
      installedBytes: 0,
      expectedBytes: 0,
      download: emptyDownload,
      errors: [],
    });
    await fulfillJson(route, {
      catalog: [],
      installed: [],
      active: {
        modelId: null,
        loaded: false,
        status: "idle",
        error: null,
        updatedAt: new Date(0).toISOString(),
      },
      downloads: [],
      hardware: { status: "unsupported" },
      assignments: {},
      textReadiness: {
        updatedAt: new Date(0).toISOString(),
        slots: {
          TEXT_SMALL: slot("TEXT_SMALL"),
          TEXT_LARGE: slot("TEXT_LARGE"),
        },
      },
    });
  });
  await page.route(
    "**/api/local-inference/downloads/stream**",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "",
      });
    },
  );

  await page.route("**/api/plugins", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, { plugins: [] });
  });

  // Views catalog — populate the launcher so the home surface mounts.
  await page.route("**/api/views**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/views/search") {
      await fulfillJson(route, { results: VIEW_FIXTURES });
      return;
    }
    await fulfillJson(route, { views: VIEW_FIXTURES });
  });
}

async function seedSettingsBackgroundStorage(
  page: Page,
  background: { mode: "shader" | "image"; color: string; imageUrl?: string },
): Promise<void> {
  await seedAppStorage(page, {
    "eliza:mobile-runtime-mode": "local",
    [UI_BACKGROUND_STORAGE_KEY]: JSON.stringify(background),
  });
}

async function installReadyDesktopStatusBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Bridge = {
      request?: Record<string, (params?: unknown) => Promise<unknown>>;
      onMessage?: (
        messageName: string,
        listener: (payload: unknown) => void,
      ) => void;
      offMessage?: (
        messageName: string,
        listener: (payload: unknown) => void,
      ) => void;
    };
    const win = window as Window & { __ELIZA_ELECTROBUN_RPC__?: Bridge };
    const existing = win.__ELIZA_ELECTROBUN_RPC__;
    const now = Date.now();
    const readyStatus = {
      state: "running",
      agentName: "Playwright Smoke",
      model: "ui-smoke",
      uptime: 60_000,
      startedAt: now - 60_000,
      pendingRestart: false,
      pendingRestartReasons: [],
      startup: { phase: "running", attempt: 0 },
    };
    const readyLaunch = {
      phase: "ready",
      agent: {
        state: "running",
        port: null,
        apiBase: null,
        startedAt: now - 60_000,
        error: null,
      },
      boot: {
        runtimePhase: "running",
        pluginsLoaded: 0,
        pluginsFailed: 0,
        database: "ok",
      },
      auth: { checked: true, required: false },
      firstRun: { checked: true, complete: true, cloudProvisioned: true },
      remotes: { seeded: true, requiredStarted: false, errors: [] },
      localModel: { backgroundDownloadQueued: false, blocking: false },
      diagnostics: { logPath: "", statusPath: "" },
      recovery: {
        canRetry: false,
        canOpenLogs: false,
        canCreateBugReport: false,
      },
      updatedAt: new Date(now).toISOString(),
    };
    const readyBoot = {
      state: "running",
      phase: "running",
      lastError: null,
      pluginsLoaded: 0,
      pluginsFailed: 0,
      database: "ok",
      agentName: "Playwright Smoke",
      port: null,
      startedAt: now - 60_000,
    };
    const withReadyStatus = (bridge?: Bridge): Bridge => ({
      request: {
        ...(bridge?.request ?? {}),
        getAgentStatus: async () => readyStatus,
        launchProgress: async () => readyLaunch,
        bootProgress: async () => readyBoot,
      },
      onMessage: bridge?.onMessage ?? (() => {}),
      offMessage: bridge?.offMessage ?? (() => {}),
    });
    let currentBridge = withReadyStatus(existing);
    Object.defineProperty(win, "__ELIZA_ELECTROBUN_RPC__", {
      configurable: true,
      get() {
        return currentBridge;
      },
      set(nextBridge: Bridge | undefined) {
        currentBridge = withReadyStatus(nextBridge);
      },
    });
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "local:playwright-smoke",
        kind: "local",
        label: "Playwright Smoke",
        apiBase: window.location.origin,
      }),
    );
  });
}

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 4,
  });
}

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

interface SettingsSeamReport {
  /** Class list of every ancestor from settings-shell up to the App root. */
  shellAncestorClasses: string[];
  /** Ancestors that paint an opaque `bg-bg` over the unified wallpaper. */
  opaqueBgAncestors: string[];
  /**
   * The #9143 fix made `RoutedShellContent`'s shell transparent for the settings
   * tab (APP_SHELL_CLASS_TRANSPARENT = no `bg-bg`). True when that fix is present
   * — i.e. the element carrying the `font-body text-txt` shell marker is NOT
   * painting an opaque `bg-bg`.
   */
  routedShellIsTransparent: boolean;
  /**
   * The opaque layer that STILL paints over the wallpaper despite the routed
   * shell being transparent — in practice `AppWorkspaceChrome`'s root `bg-bg`,
   * which every `TabContentView`/`TabScrollView` wraps the view in. `null` when
   * nothing between the shell and the App root is opaque.
   */
  remainingOpaqueLayer: string | null;
  /** The unified fixed background physically spans the full viewport (y=0..H). */
  appBackgroundReachesTop: boolean;
  backgroundKind: string | null;
}

/**
 * Walk up from the settings-shell to the App-root flex column (the element that
 * reserves the safe area via `paddingTop: var(--safe-area-top)`) and report
 * every opaque `bg-bg` ancestor. The #9143 fix made the routed shell transparent
 * for the settings tab; this inspector distinguishes that (now-correct) shell
 * from any OTHER opaque layer nested inside it that still covers the wallpaper.
 */
async function inspectSettingsSeam(page: Page): Promise<SettingsSeamReport> {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-testid="settings-shell"]');
    const ancestorClasses: string[] = [];
    const opaque: string[] = [];
    let routedShellIsTransparent = true;
    let node: Element | null = shell;
    while (node && node !== document.body) {
      const cls = node.className;
      if (typeof cls === "string" && cls.length > 0) {
        ancestorClasses.push(cls);
        const tokens = cls.split(/\s+/);
        const isOpaqueBg = tokens.includes("bg-bg");
        if (isOpaqueBg) opaque.push(cls);
        // The routed shell is the element carrying both shell markers; if it
        // also carries `bg-bg`, the #9143 fix regressed.
        if (
          tokens.includes("font-body") &&
          tokens.includes("text-txt") &&
          isOpaqueBg
        ) {
          routedShellIsTransparent = false;
        }
      }
      node = node.parentElement;
    }

    const bgEl =
      document.querySelector('[data-testid="app-background-image"]') ??
      document.querySelector('[data-testid="app-background-shader"]');
    let reachesTop = false;
    let kind: string | null = null;
    if (bgEl) {
      kind = bgEl.getAttribute("data-eliza-bg");
      const rect = bgEl.getBoundingClientRect();
      reachesTop = rect.top <= 0 && rect.bottom >= window.innerHeight - 1;
    }
    return {
      shellAncestorClasses: ancestorClasses,
      opaqueBgAncestors: opaque,
      routedShellIsTransparent,
      remainingOpaqueLayer: opaque[0] ?? null,
      appBackgroundReachesTop: reachesTop,
      backgroundKind: kind,
    };
  });
}

async function gotoSettings(page: Page): Promise<void> {
  await openAppPath(page, "/settings");
  await expect(page.getByTestId("settings-shell")).toBeVisible({
    timeout: 30_000,
  });
}

test.describe("settings shares the unified app background (#9143)", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await expectNoPageDiagnostics(page, testInfo.title);
  });

  test("captures settings over shader + photo backgrounds and diagnoses the safe-area seam", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await rm(SCREENSHOT_DIR, { force: true, recursive: true });

    const wallpaper = await busyWallpaperDataUrl();

    // -- 1) Default shader background -----------------------------------------
    await seedSettingsBackgroundStorage(page, {
      mode: "shader",
      color: "#ef5a1f",
    });
    await installReadyDesktopStatusBridge(page);
    await installSettingsBackgroundRoutes(page);

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await gotoSettings(page);

    // The unified shader background must be mounted behind the shell. It is
    // `aria-hidden` + `pointer-events-none` + `fixed`, so assert ATTACHED (in
    // the DOM, painting) rather than Playwright-"visible".
    await expect(page.getByTestId("app-background-shader")).toBeAttached({
      timeout: 15_000,
    });

    // Capture for human review FIRST — the screenshots are the real deliverable.
    await screenshot(page, "desktop-shader");

    const shaderSeam = await inspectSettingsSeam(page);
    console.log("SETTINGS_SEAM_SHADER>", JSON.stringify(shaderSeam));

    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(page.getByTestId("settings-shell")).toBeVisible();
    await screenshot(page, "mobile-shader");

    // -- 2) Photo / image background ------------------------------------------
    await page.evaluate(
      ({ key, value }) => {
        localStorage.setItem(key, value);
      },
      {
        key: UI_BACKGROUND_STORAGE_KEY,
        value: JSON.stringify({
          mode: "image",
          color: "#ef5a1f",
          imageUrl: wallpaper,
        }),
      },
    );

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await gotoSettings(page);

    await expect(page.getByTestId("app-background-image")).toBeAttached({
      timeout: 15_000,
    });
    await screenshot(page, "desktop-image");

    const imageSeam = await inspectSettingsSeam(page);
    console.log("SETTINGS_SEAM_IMAGE>", JSON.stringify(imageSeam));

    // The text-dense Settings view gets a translucent readability scrim over the
    // wallpaper (full viewport, incl. the safe area) so flat text stays legible
    // while the wallpaper still reads through. Assert it WHILE on Settings —
    // the scrim is gated to `isSettingsPage`, so it is (correctly) absent on the
    // sparse launcher captured below.
    await expect(page.getByTestId("app-background-scrim")).toBeAttached();

    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(page.getByTestId("settings-shell")).toBeVisible();
    await screenshot(page, "mobile-image");

    // -- 3) Launcher reference over the SAME photo -------------------------
    // The user wants Settings to match the launcher look; capture the home
    // launcher over the identical wallpaper so the two can be compared.
    // Depending on nav history the launcher renders either the ViewCatalog
    // ("Views" heading) or the iOS-style home-screen tile grid — accept either,
    // then confirm the image wallpaper is attached (painting) behind it.
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await openAppPath(page, "/views");
    await expect(
      page
        .getByRole("heading", { name: "Views" })
        .or(page.getByTestId("home-screen"))
        .or(page.getByRole("navigation", { name: /Pinned views/i }))
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    // The image background is `aria-hidden` + `pointer-events-none` + `fixed`,
    // which trips Playwright's strict visibility heuristic; assert it is
    // ATTACHED (in the DOM, painting the wallpaper) rather than "visible".
    await expect(page.getByTestId("app-background-image")).toBeAttached({
      timeout: 15_000,
    });
    await screenshot(page, "launcher-image-desktop");

    // -- Assertions: what the #9143 fix DOES guarantee ------------------------
    // The committed fix makes the routed shell transparent and the unified
    // background span the full viewport (incl. the safe-area top).
    for (const seam of [shaderSeam, imageSeam]) {
      expect(
        seam.routedShellIsTransparent,
        "the routed settings shell must be transparent (APP_SHELL_CLASS_TRANSPARENT, no bg-bg) — the #9143 fix",
      ).toBe(true);
      expect(
        seam.appBackgroundReachesTop,
        "the unified background must span the full viewport including the safe-area top",
      ).toBe(true);
    }
    expect(shaderSeam.backgroundKind).toBe("shader");
    expect(imageSeam.backgroundKind).toBe("image");

    // -- No opaque layer remains over the wallpaper ---------------------------
    // The full fix also made `AppWorkspaceChrome` (wrapping Settings via
    // TabContentView) transparent, so NO ancestor between settings-shell and the
    // App root paints an opaque `bg-bg` — the wallpaper is continuous, edge to
    // edge, matching the launcher.
    console.log(
      "SETTINGS_REMAINING_OPAQUE_LAYER>",
      JSON.stringify({
        shader: shaderSeam.remainingOpaqueLayer,
        image: imageSeam.remainingOpaqueLayer,
      }),
    );
    for (const seam of [shaderSeam, imageSeam]) {
      expect(
        seam.remainingOpaqueLayer,
        "no ancestor of settings-shell may paint an opaque bg-bg over the wallpaper",
      ).toBeNull();
    }

    // Sparse views (the launcher) get NO scrim — the scrim is gated to
    // `isSettingsPage`, so on `/views` it must be absent. This confirms the
    // readability scrim is scoped to text-dense Settings, not painted globally.
    await expect(page.getByTestId("app-background-scrim")).toHaveCount(0);
  });
});
