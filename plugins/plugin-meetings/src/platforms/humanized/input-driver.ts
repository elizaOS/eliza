/**
 * Concrete InputDriver backends + auto-selection.
 *
 * PlaywrightInputDriver — default; humanized `mouse.move` stepping toward the
 * element center along a mocap trajectory, then a real Playwright click. Works
 * on every platform Playwright runs (macOS dev, headless/headful Linux).
 *
 * XtestInputDriver — Linux/X11 only; replays the mocap trajectory through real
 * XTEST input (xdotool) so the browser sees isTrusted=true events. Auto-selected
 * when DISPLAY + xdotool are present, otherwise the Playwright driver is used.
 */

import { logger } from "@elizaos/core";
import type { ElementHandle, Page } from "playwright-core";
import { MocapEngine } from "./mocap.js";
import type { InputDriver, Rect } from "./types.js";
import { type PointerLocation, X11Input } from "./x11-input.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ElementMetrics {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface MouseCaptureWindow extends Window {
  __elizaLastMouse?: { clientX: number; clientY: number } | null;
}

async function metricsOf(
  page: Page,
  handle: ElementHandle<Element>,
): Promise<ElementMetrics> {
  return page.evaluate((el) => {
    const r = (el as Element).getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, handle);
}

/**
 * Humanized synthetic driver. Steps `page.mouse` along a mocap trajectory
 * scaled to the element center, then issues a trusted-to-the-page click.
 */
export class PlaywrightInputDriver implements InputDriver {
  readonly kind = "playwright" as const;
  private readonly engine: MocapEngine;

  constructor(engine: MocapEngine = new MocapEngine()) {
    this.engine = engine;
  }

  async available(): Promise<boolean> {
    return true;
  }

  private async moveHumanly(
    page: Page,
    targetX: number,
    targetY: number,
  ): Promise<void> {
    // Current pointer is unknown in Playwright; start from a stable corner and
    // walk a mocap trajectory whose displacement lands near the target.
    const start: PointerLocation = { x: 4, y: 4 };
    const rect: Rect = {
      left: targetX - 2,
      top: targetY - 2,
      right: targetX + 2,
      bottom: targetY + 2,
    };
    const seq =
      this.engine.findSequenceLandingInRect(start.x, start.y, rect) ??
      this.engine.findSequenceWithStretchAndRotation(start.x, start.y, rect);

    await page.mouse.move(start.x, start.y);
    if (seq) {
      let x = start.x;
      let y = start.y;
      for (const mv of seq.movements) {
        if (mv.dt > 0) await sleep(Math.min(mv.dt * 1000, 40));
        x += mv.dx;
        y += mv.dy;
        await page.mouse.move(x, y);
      }
    }
    // Land exactly on the target center regardless of trajectory residual.
    await page.mouse.move(targetX, targetY, { steps: 6 });
  }

  async click(page: Page, handle: ElementHandle<Element>): Promise<void> {
    const m = await metricsOf(page, handle);
    if (m.width <= 0 || m.height <= 0) {
      // Element not laid out — fall back to the handle's own click.
      await handle.click();
      return;
    }
    const cx = m.left + m.width / 2;
    const cy = m.top + m.height / 2;
    await this.moveHumanly(page, cx, cy);
    const downDt = 60 + Math.random() * 50;
    await sleep(downDt);
    await page.mouse.down();
    await sleep(50 + Math.random() * 50);
    await page.mouse.up();
  }

  async fill(
    page: Page,
    handle: ElementHandle<Element>,
    text: string,
  ): Promise<void> {
    await this.click(page, handle);
    await sleep(120 + Math.floor(Math.random() * 180));
    await handle.type(text, { delay: 55 + Math.floor(Math.random() * 50) });
  }
}

/**
 * XTEST driver. Calibrates the page↔screen mapping, replays a mocap trajectory
 * via xdotool relative moves, verifies the real pointer landed on the target,
 * then presses/releases. Fails LOUD (throws) if it cannot land on target — the
 * caller falls back to the Playwright driver.
 */
export class XtestInputDriver implements InputDriver {
  readonly kind = "xtest" as const;
  private readonly engine: MocapEngine;
  private readonly x11: X11Input;
  private offsetX = 0;
  private offsetY = 0;
  private dpr = 1;
  private calibrated = false;
  private static readonly SLACK_PX = 3;
  private static readonly MAX_CORRECTIONS = 4;

  constructor(
    opts: { display?: string; dryRun?: boolean; engine?: MocapEngine } = {},
  ) {
    this.engine = opts.engine ?? new MocapEngine();
    this.x11 = new X11Input({ display: opts.display, dryRun: opts.dryRun });
  }

  async available(): Promise<boolean> {
    return this.x11.isAvailable();
  }

  private async calibrate(page: Page, force = false): Promise<void> {
    if (this.calibrated && !force) return;
    this.dpr = await page.evaluate(() => window.devicePixelRatio || 1);

    await page.evaluate(() => {
      const mouseWindow = window as MouseCaptureWindow;
      mouseWindow.__elizaLastMouse = null;
      window.addEventListener(
        "mousemove",
        (e) => {
          mouseWindow.__elizaLastMouse = {
            clientX: e.clientX,
            clientY: e.clientY,
          };
        },
        { capture: true },
      );
    });

    const geo = await page.evaluate(() => ({
      sx: window.screenX,
      sy: window.screenY,
      iw: window.innerWidth,
      ih: window.innerHeight,
    }));

    const probes = [
      {
        x: Math.round((geo.sx + geo.iw * 0.35) * this.dpr),
        y: Math.round((geo.sy + geo.ih * 0.4) * this.dpr),
      },
      {
        x: Math.round((geo.sx + geo.iw * 0.6) * this.dpr),
        y: Math.round((geo.sy + geo.ih * 0.6) * this.dpr),
      },
    ];

    let sample: { sx: number; sy: number; cx: number; cy: number } | null =
      null;
    for (const p of probes) {
      await this.x11.moveAbs(p.x, p.y);
      await sleep(120);
      const ev = await page.evaluate(
        () => (window as MouseCaptureWindow).__elizaLastMouse,
      );
      if (ev) {
        sample = { sx: p.x, sy: p.y, cx: ev.clientX, cy: ev.clientY };
        break;
      }
    }

    if (sample) {
      this.offsetX = sample.sx - sample.cx * this.dpr;
      this.offsetY = sample.sy - sample.cy * this.dpr;
    } else {
      this.offsetX = geo.sx * this.dpr;
      this.offsetY = geo.sy * this.dpr;
      logger.warn(
        "[XtestInputDriver] calibration fell back to screenX/Y formula",
      );
    }
    this.calibrated = true;
  }

  private rectDevicePx(m: ElementMetrics): Rect {
    const inset = 0.18;
    const ix = m.width * inset;
    const iy = m.height * inset;
    return {
      left: Math.round(this.offsetX + (m.left + ix) * this.dpr),
      top: Math.round(this.offsetY + (m.top + iy) * this.dpr),
      right: Math.round(this.offsetX + (m.left + m.width - ix) * this.dpr),
      bottom: Math.round(this.offsetY + (m.top + m.height - iy) * this.dpr),
    };
  }

  private screenToPage(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.offsetX) / this.dpr,
      y: (sy - this.offsetY) / this.dpr,
    };
  }

  private pageToScreen(px: number, py: number): { x: number; y: number } {
    return { x: this.offsetX + px * this.dpr, y: this.offsetY + py * this.dpr };
  }

  private async pointerHitsTarget(
    page: Page,
    handle: ElementHandle<Element>,
  ): Promise<{ ok: boolean; m: ElementMetrics; pageX: number; pageY: number }> {
    const m = await metricsOf(page, handle);
    const pointer = await this.x11.getPointer();
    const { x: pageX, y: pageY } = this.screenToPage(pointer.x, pointer.y);
    const s = XtestInputDriver.SLACK_PX;
    const insideRect =
      pageX >= m.left - s &&
      pageX <= m.left + m.width + s &&
      pageY >= m.top - s &&
      pageY <= m.top + m.height + s;
    if (!insideRect) return { ok: false, m, pageX, pageY };
    const onTarget = await page.evaluate(
      ([px, py, el]) => {
        const hit = document.elementFromPoint(px as number, py as number);
        return (
          !!hit &&
          (hit === el ||
            (el as Element).contains(hit as Node) ||
            (hit as Element).contains(el as Node))
        );
      },
      [pageX, pageY, handle] as const,
    );
    return { ok: onTarget, m, pageX, pageY };
  }

  private async replayTowards(
    page: Page,
    handle: ElementHandle<Element>,
  ): Promise<void> {
    await page.waitForTimeout(120);
    const m = await metricsOf(page, handle);
    if (m.width <= 0 || m.height <= 0)
      throw new Error("[XtestInputDriver] element has zero size");
    const rect = this.rectDevicePx(m);
    const cur = await this.x11.getPointer();
    const seq =
      this.engine.findSequenceLandingInRect(cur.x, cur.y, rect) ??
      this.engine.findSequenceWithStretchAndRotation(cur.x, cur.y, rect);
    if (!seq)
      throw new Error(
        "[XtestInputDriver] no mocap sequence lands on target element",
      );
    for (const mv of seq.movements) {
      if (mv.dt > 0) await sleep(mv.dt * 1000);
      if (mv.dx !== 0 || mv.dy !== 0) await this.x11.moveRel(mv.dx, mv.dy);
    }
  }

  async click(page: Page, handle: ElementHandle<Element>): Promise<void> {
    await this.calibrate(page);
    await this.replayTowards(page, handle);

    let hit = await this.pointerHitsTarget(page, handle);
    for (let i = 0; !hit.ok && i < XtestInputDriver.MAX_CORRECTIONS; i++) {
      await this.calibrate(page, true);
      const cx = hit.m.left + hit.m.width / 2;
      const cy = hit.m.top + hit.m.height / 2;
      const target = this.pageToScreen(cx, cy);
      await this.x11.moveAbs(Math.round(target.x), Math.round(target.y));
      await sleep(60);
      hit = await this.pointerHitsTarget(page, handle);
    }

    if (!hit.ok) {
      throw new Error(
        `[XtestInputDriver] click target verification failed after ${XtestInputDriver.MAX_CORRECTIONS} corrections — ` +
          `pointer page=(${hit.pageX.toFixed(0)},${hit.pageY.toFixed(0)}) not inside control`,
      );
    }

    await sleep(60 + Math.random() * 50);
    await this.x11.buttonDown(1);
    await sleep(50 + Math.random() * 50);
    await this.x11.buttonUp(1);
  }

  async fill(
    page: Page,
    handle: ElementHandle<Element>,
    text: string,
  ): Promise<void> {
    await this.click(page, handle);
    await sleep(120 + Math.floor(Math.random() * 180));
    await this.x11.typeText(text, 55 + Math.floor(Math.random() * 50));
  }
}

/**
 * Auto-select the strongest available driver: XTEST on Linux/X11 when xdotool
 * is present (isTrusted=true, defeats Meet detection), else the humanized
 * Playwright driver. Selection happens once; the returned driver is reused.
 */
export async function selectInputDriver(): Promise<InputDriver> {
  const engine = new MocapEngine();
  if (process.platform === "linux" && process.env.DISPLAY) {
    const xtest = new XtestInputDriver({ engine });
    if (await xtest.available()) {
      logger.info("[InputDriver] using XTEST (real OS-level input)");
      return xtest;
    }
    logger.warn(
      "[InputDriver] DISPLAY set but xdotool unavailable — using humanized Playwright input",
    );
  }
  logger.info("[InputDriver] using humanized Playwright input");
  return new PlaywrightInputDriver(engine);
}
