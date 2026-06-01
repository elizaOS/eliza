import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Live UI e2e for the /orchestrator workbench. It drives the real running dev
// stack (`bun run dev:web:ui`) with a headless browser and asserts the things
// that actually broke in practice: raw ACP JSON leaking into the transcript,
// horizontal overflow, the user's own message not appearing after sending, and
// any console/page errors. It is gated on the stack being reachable, so it is a
// no-op (skipped) in environments without a running stack — run it explicitly
// with `bun run --cwd plugins/plugin-task-coordinator test:e2e:manual`.

const BASE = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:2138";

function httpCode(url: string): string {
  const result = spawnSync(
    "curl",
    ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "4", url],
    { encoding: "utf8" },
  );
  return (result.stdout ?? "").trim();
}

// Both the UI and the API proxy must answer 200 — the API check ensures the
// agent is actually up, not just vite serving the shell.
const STACK_UP =
  httpCode(`${BASE}/orchestrator`) === "200" &&
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
  return undefined; // fall back to Playwright's bundled Chromium
}

// Console noise that is environmental (GPU/canvas perf hints, dev resource
// 404s) rather than an application error. "API server unavailable" startup
// warnings and WebSocket connection failures are dev-stack connection-timing:
// the dev supervisor respawns the agent on exit, so a page load can briefly
// race a respawning API/WS — the UI handles this gracefully (logs + reconnects)
// and a genuine API outage is still caught by the functional tests above.
const IGNORED_CONSOLE =
  /Failed to load resource|willReadFrequently|WebGL|GPU stall|\[vite\]|API server unavailable|WebSocket connection to|ERR_CONNECTION_REFUSED/;

// The raw ACP content-block JSON that must never reach the rendered transcript.
const RAW_ACP_JSON = /\[\s*\{\s*"type"\s*:\s*"(?:diff|content|text)"/;

describe.skipIf(!STACK_UP)("orchestrator workbench (live e2e)", () => {
  let context: BrowserContext;
  let page: Page;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  async function present(testid: string): Promise<boolean> {
    return (await page.locator(`[data-testid="${testid}"]`).count()) > 0;
  }

  async function ensureWorkbench(): Promise<void> {
    // Brand-new browser profiles hit the "Where should Eliza run?" onboarding;
    // pick Local and connect so the workbench loads. A returning profile skips
    // straight through.
    for (let i = 0; i < 40; i++) {
      if (await present("orchestrator-workbench")) return;
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
    throw new Error("orchestrator workbench never loaded");
  }

  async function openTask(index: number): Promise<void> {
    await page
      .locator('[data-testid="orchestrator-task-item"]')
      .nth(index)
      .click();
    await page.waitForTimeout(1200);
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
    page.on("console", (message) => {
      const type = message.type();
      if (type !== "error" && type !== "warning") return;
      const text = message.text();
      if (!IGNORED_CONSOLE.test(text)) consoleErrors.push(text.slice(0, 200));
    });
    page.on("pageerror", (error) =>
      pageErrors.push(String(error).slice(0, 240)),
    );
    await page.goto(`${BASE}/orchestrator`, { waitUntil: "domcontentloaded" });
    await ensureWorkbench();
    await page.waitForTimeout(1200);
  }, 120_000);

  afterAll(async () => {
    await context?.close();
  });

  it("loads the workbench with no page errors", async () => {
    expect(await present("orchestrator-workbench")).toBe(true);
    expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  });

  it("renders every task without raw ACP JSON in the transcript", async () => {
    const count = await page
      .locator('[data-testid="orchestrator-task-item"]')
      .count();
    for (let i = 0; i < count; i++) {
      await openTask(i);
      const text = await page
        .locator('[data-testid="orchestrator-message-list"]')
        .innerText()
        .catch(() => "");
      expect(RAW_ACP_JSON.test(text), `task ${i} leaked raw ACP JSON`).toBe(
        false,
      );
      expect(text).not.toContain("[object Object]");
      expect(text).not.toContain("undefined\n");
    }
  }, 120_000);

  it("does not overflow the transcript horizontally", async () => {
    const count = await page
      .locator('[data-testid="orchestrator-task-item"]')
      .count();
    for (let i = 0; i < count; i++) {
      await openTask(i);
      const overflow = await page.evaluate(() => {
        const el = document.querySelector(
          '[data-testid="orchestrator-message-list"]',
        );
        return el ? el.scrollWidth - el.clientWidth : 0;
      });
      expect(
        overflow,
        `task ${i} overflows by ${overflow}px`,
      ).toBeLessThanOrEqual(4);
    }
  }, 120_000);

  it("shows the user's message in the transcript after sending", async () => {
    const items = page.locator('[data-testid="orchestrator-task-item"]');
    if ((await items.count()) === 0) return;
    await openTask(0);
    const composer = page
      .locator(
        '[data-testid="orchestrator-composer"] textarea, [data-testid="orchestrator-composer"] input, textarea',
      )
      .first();
    expect(await composer.count()).toBeGreaterThan(0);
    const probe = `e2e-probe-${process.pid}-${Math.floor(performance.now())}`;
    await composer.fill(probe);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2500);
    const transcript = await page
      .locator('[data-testid="orchestrator-message-list"]')
      .innerText()
      .catch(() => "");
    expect(
      transcript.includes(probe),
      "the sent message never appeared in the transcript",
    ).toBe(true);
  }, 60_000);

  it("opens and closes the create-task dialog", async () => {
    if (!(await present("orchestrator-new-task"))) return;
    await page.locator('[data-testid="orchestrator-new-task"]').first().click();
    await page.waitForTimeout(600);
    expect(await present("orchestrator-create-dialog")).toBe(true);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    expect(await present("orchestrator-create-dialog")).toBe(false);
  }, 60_000);

  it("had no application console errors across the session", () => {
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });
});
