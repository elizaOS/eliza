#!/usr/bin/env node
/**
 * Headless checker: loads every Storybook story in isolation and captures
 * render errors (SB error overlay, page errors, console.error).
 *
 * Numeric CLI overrides fail closed before Playwright launches so a typo or
 * negative bound cannot silently drop stories or rewrite settle timing.
 *
 * Usage:
 *   node stories/check-stories.mjs [--base http://localhost:6006] [--limit N]
 *     [--filter substr] [--globals theme:light] [--settle MS] [--ids-file path]
 */
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";

export const DEFAULT_SETTLE_MS = 600;

/**
 * Require a complete unsigned decimal string that is a positive safe integer.
 * Rejects partial numeric prefixes (`1junk`), fractions, signs, and zero so a
 * limit never becomes NaN/negative and silently changes which stories run.
 *
 * @param {string | undefined} raw
 * @param {string} flag
 * @returns {number}
 */
export function requirePositiveSafeInteger(raw, flag) {
  if (raw === undefined) {
    throw new Error(
      `check-stories: ${flag} requires a positive integer (received no value)`,
    );
  }
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
    throw new Error(
      `check-stories: ${flag} must be a positive integer (received ${JSON.stringify(raw)})`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `check-stories: ${flag} must be a positive safe integer (received ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

/**
 * Require a complete unsigned decimal string that is a non-negative safe
 * integer. Zero is allowed so operators can disable the post-navigation settle.
 *
 * @param {string | undefined} raw
 * @param {string} flag
 * @returns {number}
 */
export function requireNonNegativeSafeInteger(raw, flag) {
  if (raw === undefined) {
    throw new Error(
      `check-stories: ${flag} requires a non-negative integer (received no value)`,
    );
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new Error(
      `check-stories: ${flag} must be a non-negative integer (received ${JSON.stringify(raw)})`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== raw) {
    throw new Error(
      `check-stories: ${flag} must be a non-negative safe integer (received ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

/**
 * Parse CLI argv into checker options. Unknown flags are ignored for backward
 * compatibility with ad-hoc local invocations; numeric flags fail closed.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = {
    base: "http://localhost:6006",
    limit: 0,
    filter: "",
    globals: "",
    idsFile: "",
    settle: DEFAULT_SETTLE_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--base") {
      const value = next();
      if (value === undefined) {
        throw new Error("check-stories: --base requires a URL value");
      }
      options.base = value;
    } else if (flag === "--limit") {
      options.limit = requirePositiveSafeInteger(next(), "--limit");
    } else if (flag === "--filter") {
      const value = next();
      if (value === undefined) {
        throw new Error("check-stories: --filter requires a value");
      }
      options.filter = value;
    } else if (flag === "--globals") {
      const value = next();
      if (value === undefined) {
        throw new Error("check-stories: --globals requires a value");
      }
      options.globals = value;
    } else if (flag === "--ids-file") {
      const value = next();
      if (value === undefined) {
        throw new Error("check-stories: --ids-file requires a path value");
      }
      options.idsFile = value;
    } else if (flag === "--settle") {
      options.settle = requireNonNegativeSafeInteger(next(), "--settle");
    }
  }
  return options;
}

const isTransientNavigationError = (message) =>
  /net::ERR_(ABORTED|CONNECTION_REFUSED)|Execution context was destroyed/i.test(
    message,
  );

/**
 * Run the headless story checker with already-validated options.
 *
 * @param {{
 *   base: string;
 *   limit: number;
 *   filter: string;
 *   globals: string;
 *   idsFile: string;
 *   settle: number;
 * }} options
 */
export async function runCheckStories(options) {
  const { base, limit, filter, globals, idsFile, settle } = options;
  let ids;
  if (idsFile) {
    const fsmod = await import("node:fs");
    ids = fsmod
      .readFileSync(idsFile, "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    const index = await (await fetch(`${base}/index.json`)).json();
    ids = Object.values(index.entries)
      .filter((e) => e.type === "story")
      .map((e) => e.id);
  }
  if (filter) ids = ids.filter((id) => id.includes(filter));
  if (limit) ids = ids.slice(0, limit);

  console.log(`Checking ${ids.length} stories at ${base}`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1024, height: 768 },
  });
  const page = await ctx.newPage();

  const bad = [];
  let n = 0;
  for (const id of ids) {
    n++;
    const errs = [];
    const onConsole = (msg) => {
      if (msg.type() === "error") errs.push("console: " + msg.text());
    };
    const onPageErr = (e) =>
      errs.push("pageerror: " + (e?.message || String(e)));
    page.on("console", onConsole);
    page.on("pageerror", onPageErr);
    let overlay = "";
    for (let storyAttempt = 0; storyAttempt < 2; storyAttempt++) {
      errs.length = 0;
      overlay = "";
      try {
        const url = new URL(`${base}/iframe.html`);
        url.searchParams.set("id", id);
        url.searchParams.set("viewMode", "story");
        if (globals) url.searchParams.set("globals", globals);
        let lastGotoError;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await page.goto(url.toString(), {
              waitUntil: "load",
              timeout: 30000,
            });
            lastGotoError = undefined;
            break;
          } catch (e) {
            lastGotoError = e;
            if (!isTransientNavigationError(e.message)) break;
            await page.waitForTimeout(500);
          }
        }
        if (lastGotoError) throw lastGotoError;
        // Let the story render / Vite compile settle.
        await page.waitForTimeout(settle);
        overlay = await page.evaluate(() => {
          const body = document.body;
          if (body && body.classList.contains("sb-show-errordisplay")) {
            const m = document.querySelector("#error-message, .sb-errordisplay");
            return (m?.textContent || "error overlay").trim().slice(0, 400);
          }
          return "";
        });
        break;
      } catch (e) {
        if (storyAttempt === 0 && isTransientNavigationError(e.message)) {
          await page.waitForTimeout(500);
          continue;
        }
        errs.push("goto: " + e.message);
        break;
      }
    }
    page.off("console", onConsole);
    page.off("pageerror", onPageErr);
    // Filter benign noise.
    const realErrs = errs.filter(
      (e) =>
        !/Failed to load resource.*favicon/i.test(e) &&
        !/Download the React DevTools/i.test(e) &&
        !/\[vite\] connect(ing|ed)/i.test(e) &&
        !/Error loading story index/i.test(e) &&
        !/Failed to fetch.*PreviewWeb\.getStoryIndexFromServer/is.test(e) &&
        !/Preview\.onStoriesChanged\(\)`? before initialization/i.test(e) &&
        // ErrorBoundary stories deliberately throw to demonstrate the fallback.
        !/Simulated render failure/i.test(e) &&
        !/The above error occurred in the <Boom>/i.test(e),
    );
    if (overlay || realErrs.length) {
      bad.push({ id, overlay, errs: realErrs.slice(0, 4) });
      process.stdout.write("X");
    } else {
      process.stdout.write(".");
    }
    if (n % 50 === 0) process.stdout.write(` ${n}\n`);
    // Gentle pacing so the dev server's on-demand compiler isn't overwhelmed.
    await page.waitForTimeout(150);
  }
  process.stdout.write("\n");

  await browser.close();

  console.log(`\n=== ${bad.length}/${ids.length} stories with issues ===\n`);
  for (const b of bad) {
    console.log(`\n## ${b.id}`);
    if (b.overlay) console.log("  OVERLAY: " + b.overlay.replace(/\n/g, " ⏎ "));
    for (const e of b.errs) console.log("  " + e.replace(/\n/g, " ⏎ "));
  }

  const fs = await import("node:fs");
  fs.writeFileSync(
    new URL("./check-stories-report.json", import.meta.url),
    JSON.stringify(bad, null, 2),
  );
  console.log(`\nReport: stories/check-stories-report.json`);
  return bad;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await runCheckStories(options);
}

// Only auto-run as a CLI; importing this module for unit tests must not launch
// a browser. pathToFileURL comparison is required on Windows where argv[1] is
// backslash-separated and drive-lettered.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
