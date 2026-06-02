import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Live UI e2e for the odysseus port at /odysseus. Drives the real running dev
// stack (`bun run dev:web:ui`) headless and asserts the surfaces this port
// ships: shell chrome, composer, theme engine (preset recolor + canvas effects),
// and the reuse-backed Memory/Skills panels (against real agent data). Gated on
// the stack being reachable — a no-op (skipped) without a running stack; run via
// `bun run --cwd plugins/plugin-task-coordinator test:e2e:manual`.

const BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:2138";

function httpCode(url: string): string {
  const result = spawnSync(
    "curl",
    ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "4", url],
    { encoding: "utf8" },
  );
  return (result.stdout ?? "").trim();
}

const STACK_UP =
  httpCode(`${BASE}/odysseus`) === "200" &&
  httpCode(`${BASE}/api/orchestrator/tasks`) === "200";

function chromePath(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const IGNORED_CONSOLE =
  /Failed to load resource|willReadFrequently|WebGL|GPU stall|\[vite\]|API server unavailable|WebSocket connection to|ERR_CONNECTION_REFUSED/;

describe.skipIf(!STACK_UP)("odysseus shell (live e2e)", () => {
  let context: BrowserContext;
  let page: Page;
  const pageErrors: string[] = [];

  async function ensureShell(): Promise<void> {
    // ~90s budget — covers a cold dev-server compile of the view bundle.
    for (let i = 0; i < 90; i++) {
      if (await page.locator('[data-testid="odysseus-shell"]').count()) return;
      const connect = page.getByRole("button", { name: /^connect$/i }).first();
      if (await connect.isVisible().catch(() => false)) {
        await page
          .getByText("Local", { exact: false })
          .first()
          .click()
          .catch(() => {});
        await connect.click().catch(() => {});
      }
      await page.waitForTimeout(1000);
    }
    throw new Error("odysseus shell never loaded");
  }

  const bgVar = () =>
    page.evaluate(() =>
      getComputedStyle(
        document.querySelector('[data-testid="odysseus-shell"]') as Element,
      )
        .getPropertyValue("--bg")
        .trim(),
    );

  async function openTheme() {
    await page.locator('.od-rail-btn[aria-label="Theme"]').click();
    await page.waitForTimeout(300);
  }
  // The theme menu stays open while tweaking pills (font/density/bg) — odysseus
  // behaviour; close it via its backdrop before touching the rail again.
  async function closeTheme() {
    await page
      .locator('[aria-label="Close theme menu"]')
      .click({ timeout: 1500 })
      .catch(() => {});
    await page.waitForTimeout(200);
  }
  // Memory/Skills overlays center the panel over the full-size backdrop, so a
  // backdrop-center click lands on the panel; Escape (handled by the auto-
  // focused search input) closes reliably.
  async function closeOverlay() {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(250);
  }

  beforeAll(async () => {
    context = await chromium.launchPersistentContext(
      process.env.ORCH_PROFILE ??
        path.join(os.tmpdir(), "eliza-orch-e2e-profile"),
      {
        headless: true,
        viewport: { width: 1600, height: 1000 },
        executablePath: chromePath(),
        args: ["--no-sandbox", "--disable-gpu"],
      },
    );
    page = context.pages()[0] ?? (await context.newPage());
    page.on("pageerror", (error) =>
      pageErrors.push(String(error).slice(0, 240)),
    );
    page.on("console", (m) => {
      if (m.type() === "error" && !IGNORED_CONSOLE.test(m.text()))
        pageErrors.push(m.text().slice(0, 200));
    });
    // `commit` (fires on navigation start) instead of `domcontentloaded`: the
    // dev server lazily compiles the (large) view bundle on the first cold
    // request, which can exceed the default 30s DOMContentLoaded wait. The shell
    // selector poll in ensureShell() is the real readiness gate.
    await page.goto(`${BASE}/odysseus`, {
      waitUntil: "commit",
      timeout: 120_000,
    });
    await ensureShell();
    await page.waitForTimeout(800);
  }, 120_000);

  afterAll(async () => {
    await context?.close();
  });

  it("renders the shell chrome with no page errors", async () => {
    expect(await page.locator('[data-testid="odysseus-shell"]').count()).toBe(
      1,
    );
    expect(await page.locator(".od-icon-rail").count()).toBe(1);
    expect(await page.locator(".od-sidebar").count()).toBe(1);
    expect(await page.locator(".od-input-bar").count()).toBe(1);
    expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  });

  it("theme presets recolor the shell (cyberpunk → restore dark)", async () => {
    await openTheme();
    await page.locator(".od-theme-swatch", { hasText: "cyberpunk" }).click();
    await page.waitForTimeout(300);
    expect(await bgVar()).toBe("#0a0a0f");
    await openTheme();
    await page.locator(".od-theme-swatch", { hasText: "dark" }).first().click();
    await page.waitForTimeout(300);
    expect(await bgVar()).toBe("#282c34");
  });

  it("canvas bg-effects mount when selected", async () => {
    await openTheme();
    await page.locator(".od-theme-pill", { hasText: "sparkles" }).click();
    await page.waitForTimeout(400);
    expect(await page.locator(".od-bg-canvas").count()).toBe(1);
    // pills keep the menu open; reuse it, then close before leaving.
    await page.locator(".od-theme-pill", { hasText: "none" }).click();
    await page.waitForTimeout(200);
    expect(await page.locator(".od-bg-canvas").count()).toBe(0);
    await closeTheme();
  });

  it("memory panel lists real memories (reused plugin-sql backend)", async () => {
    await closeTheme();
    await page.locator('.od-rail-btn[aria-label="Memory"]').click();
    // The panel loads stats + the memory feed on open; wait for the first row
    // (browse tab is the default) rather than a fixed delay.
    await page
      .locator(".od-mem-item")
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => {});
    expect(await page.locator(".od-mem-item").count()).toBeGreaterThan(0);
    await closeOverlay();
  });

  it("skills panel lists skills (reused plugin-agent-skills backend)", async () => {
    await closeOverlay();
    await page.locator('.od-rail-btn[aria-label="Skills"]').click();
    // Skills render as expandable cards (.od-skills-card) post-redesign.
    await page
      .locator(".od-skills-card")
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => {});
    expect(await page.locator(".od-skills-card").count()).toBeGreaterThan(0);
    await closeOverlay();
  });

  // The ported tool views (wave 1 + 2): each rail launcher opens an overlay
  // panel and Escape closes it, with no page errors. Asserts the surface mounts
  // — fidelity/data is verified per-view elsewhere (screenshots).
  const TOOL_VIEWS = [
    "Documents",
    "Compare",
    "Deep Research",
    "Calendar",
    "Tasks",
    "Models",
    "Email",
    "Gallery",
    "Cookbook",
    "Image Editor",
    "Group Chat",
    "Admin",
  ];
  for (const label of TOOL_VIEWS) {
    it(`opens + closes the ${label} view`, async () => {
      await closeOverlay();
      await page.locator(`.od-rail-btn[aria-label="${label}"]`).click();
      await page.waitForTimeout(700);
      expect(await page.locator(".od-search-overlay").count()).toBeGreaterThan(
        0,
      );
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      expect(await page.locator(".od-search-overlay").count()).toBe(0);
    });
  }

  // Pin/star a thread (odysseus): pinning floats it to the top of the Chats
  // list with a star, and persists; unpinning clears it. Needs ≥2 threads on
  // the live stack — soft-skips otherwise.
  it("pinning a thread floats it to the top with a star", async () => {
    await closeOverlay();
    await page.evaluate(() =>
      window.localStorage.removeItem("odysseus:pinned-threads"),
    );
    await page.reload({ waitUntil: "commit", timeout: 120_000 });
    await ensureShell();
    await page.waitForTimeout(600);

    const rows = page.locator(".od-thread-row");
    const count = await rows.count();
    if (count < 2) return; // not enough threads to prove reordering

    const lastTitle = (
      await rows
        .nth(count - 1)
        .locator(".od-grow")
        .innerText()
    ).trim();
    await rows.nth(count - 1).hover();
    await rows
      .nth(count - 1)
      .locator(".od-thread-menu-btn")
      .click();
    await page.waitForTimeout(150);
    await page.getByRole("button", { name: /^Pin$/ }).click();
    await page.waitForTimeout(300);

    const firstTitle = (
      await rows.nth(0).locator(".od-grow").innerText()
    ).trim();
    expect(firstTitle).toBe(lastTitle);
    expect(await rows.nth(0).locator(".od-thread-pin-dot").count()).toBe(1);
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem("odysseus:pinned-threads"),
      ),
    ).toContain('"');

    // Unpin (cleanup) → pref empties.
    await rows.nth(0).hover();
    await rows.nth(0).locator(".od-thread-menu-btn").click();
    await page.waitForTimeout(150);
    await page.getByRole("button", { name: /^Unpin$/ }).click();
    await page.waitForTimeout(250);
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem("odysseus:pinned-threads"),
      ),
    ).toBe("[]");
  });

  // Drag-resize the sidebar (odysseus .sidebar-resize-handle): widen on drag,
  // clamp at the 180px floor, and persist the final width across reload. Runs
  // last because it reloads the page.
  it("sidebar resize handle widens, clamps, and persists", async () => {
    await closeOverlay();
    const sidebar = page.locator(".od-sidebar").first();
    const handle = page.locator(".od-sidebar-resize-handle").first();
    expect(await handle.count()).toBe(1);

    const widthOf = async () => (await sidebar.boundingBox())?.width ?? 0;
    const dragBy = async (dx: number) => {
      const hb = await handle.boundingBox();
      if (!hb) throw new Error("resize handle has no box");
      const cx = hb.x + hb.width / 2;
      const cy = hb.y + hb.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + dx / 2, cy, { steps: 5 });
      await page.mouse.move(cx + dx, cy, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(200);
    };

    const w0 = await widthOf();
    await dragBy(70);
    expect(await widthOf()).toBeGreaterThan(w0 + 40);

    // Drag far left → clamps at the 180px floor.
    await dragBy(-400);
    expect(Math.abs((await widthOf()) - 180)).toBeLessThan(3);
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem("odysseus:sidebar-width"),
      ),
    ).toBe("180");

    // Persisted width survives a reload.
    await page.reload({ waitUntil: "commit", timeout: 120_000 });
    await ensureShell();
    await page.waitForTimeout(400);
    expect(Math.abs((await widthOf()) - 180)).toBeLessThan(3);
  });
});
