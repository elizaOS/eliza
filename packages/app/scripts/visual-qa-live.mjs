#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Live visual-QA sweep against a running dashboard dev server. Complements the
 * heavier `audit:app` (which prebuilds every plugin-view bundle and walks the
 * full route matrix): this tool points a headless Chromium at an *already
 * running* server, captures a small matrix of the states that actually matter
 * for the MVP — the pre-auth onboarding gate, the keyboard-adjacent mobile
 * composer, and (by seeding a session) the post-onboarding shell + its designed
 * error render — and runs each capture through the repo's own `visual-qa.mjs`
 * analyzer (OCR + dominant palette + brand-colour fractions). One report.json +
 * a terminal summary come out; `--strict` turns the brand-colour invariant
 * ("no blue", elizaOS orange is accent-only) into a non-zero exit so a lane can
 * gate on it.
 *
 * Why seeding: onboarding gates every route behind "Sign in to Eliza Cloud",
 * so a fresh browser only ever sees the gate. Injecting the canonical
 * `steward_session_token` + `eliza:first-run-complete=1` into an *isolated*
 * Playwright context (its own localStorage — it never touches the running
 * server's state or other users) lets the sweep reach the post-onboarding shell
 * and, when no backend is reachable, the designed failure state — which is the
 * three-state-rule render worth verifying (see #14415).
 *
 * Consumed by: an operator or coding agent doing a fast pre-PR visual pass
 * without the multi-minute `audit:app` prebuild. Not a CI gate unless a lane
 * opts in with `--strict`.
 *
 * Usage:
 *   node scripts/visual-qa-live.mjs --base http://127.0.0.1:2138 [--out DIR] [--strict]
 */
import { chromium } from "@playwright/test";
import { analyzeScreenshot, changeMetric } from "./lib/visual-qa.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mirrors the canonical Steward seed contract in
// `test/ui-smoke/helpers/test-auth.ts` (STEWARD_SESSION_TOKEN_KEY + the
// alg:none/exp:4102444800 JWT shape) and the first-run flag written by
// `state/persistence.ts` (`"1"`). Playwright specs import that helper directly;
// this is a standalone node script and cannot import the .ts helper at runtime,
// so the shape is duplicated here on purpose — keep the two in sync.
export const STEWARD_SESSION_TOKEN_KEY = "steward_session_token";
export const FIRST_RUN_COMPLETE_KEY = "eliza:first-run-complete";

/** base64url without padding — matches the renderer's test-auth JWT shape. */
function base64Url(input) {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * An unsigned-but-decodable Steward JWT plus the first-run-complete flag. The
 * token is decodable (renderer reads its claims) but unsigned, so it never
 * passes real API auth — which is exactly why the seeded sweep surfaces the
 * designed "backend unreachable" error state rather than live data.
 */
export function buildOnboardedSeed({ subject = "visual-qa-user" } = {}) {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      sub: subject,
      userId: subject,
      email: "visual-qa@example.test",
      exp: 4102444800, // 2100-01-01 — never triggers a refresh mid-sweep.
    }),
  );
  return {
    [STEWARD_SESSION_TOKEN_KEY]: `${header}.${payload}.unsigned`,
    [FIRST_RUN_COMPLETE_KEY]: "1",
  };
}

/**
 * The state matrix. Each entry is one capture: a viewport, a seed profile
 * (fresh = onboarding gate, onboarded = seeded shell), a route, and an optional
 * `focusComposer` step to exercise the keyboard-adjacent mobile layout.
 */
export const VIEWPORTS = {
  desktop: { width: 1280, height: 800, isMobile: false, hasTouch: false },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
};

export function buildStateMatrix() {
  const states = [];
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    states.push({
      id: `${vpName}-onboarding`,
      viewport: vpName,
      seed: "fresh",
      route: "/",
    });
    states.push({
      id: `${vpName}-shell`,
      viewport: vpName,
      seed: "onboarded",
      route: "/views",
    });
    states.push({
      id: `${vpName}-chat`,
      viewport: vpName,
      seed: "onboarded",
      route: "/chat",
    });
    if (vp.isMobile) {
      states.push({
        id: `${vpName}-composer-focused`,
        viewport: vpName,
        seed: "fresh",
        route: "/",
        focusComposer: true,
      });
    }
  }
  return states;
}

export function buildCaptureUrl(base, route) {
  return new URL(route, base.endsWith("/") ? base : `${base}/`).toString();
}

/**
 * Fold per-capture analyzer reports into a pass/fail. The brand invariant is
 * the only hard gate: blue must stay under the ceiling on every state (elizaOS
 * ships zero blue; orange is accent-only). A capture with no measured
 * `blue_fraction` is a broken analyzer run, not a clean screen — it fails
 * closed (never read "unmeasured" as 0). Returns the failing state ids so the
 * caller can report *which* screen broke, not just that something did.
 */
export function aggregateVerdict(reports, { blueCeiling = 0.02 } = {}) {
  const offenders = [];
  for (const r of reports) {
    const blue = r.color_fractions?.blue_fraction;
    if (!Number.isFinite(blue)) {
      offenders.push({
        id: r.id,
        blue: null,
        reason: "blue_fraction not measured",
      });
    } else if (blue > blueCeiling) {
      offenders.push({
        id: r.id,
        blue,
        reason: `blue over ceiling ${blueCeiling}`,
      });
    }
  }
  return { pass: offenders.length === 0, offenders, blueCeiling };
}

/**
 * Seed-vacuity gate: if the onboarded-seed contract drifts (renamed key, new
 * gate), every "seeded" capture silently re-renders the onboarding gate and
 * the sweep passes on the wrong pixels. Requiring the gate and the seeded
 * shell to differ materially per viewport turns that silent drift into a hard
 * failure. `deltas` is `[{ viewport, changedFraction }]` from `changeMetric`.
 */
export function seedDriftOffenders(deltas, { minChangedFraction = 0.02 } = {}) {
  return deltas
    .filter((d) => !(d.changedFraction > minChangedFraction))
    .map((d) => ({ viewport: d.viewport, changedFraction: d.changedFraction }));
}

async function focusAndType(page) {
  // Prefer the canonical chat composer; the generic fallback keeps the capture
  // meaningful on gates that render a plain input. No match fails the sweep —
  // a keyboard-adjacent capture without a focused field proves nothing.
  const composer = page.locator('[data-testid="chat-composer-textarea"]');
  const box = (await composer.count())
    ? composer.first()
    : page
        .locator('textarea, [contenteditable="true"], input[type="text"]')
        .first();
  await box.click({ timeout: 4000 });
  await box.type("remind me to call the pharmacy before 5", { delay: 8 });
  await page.waitForTimeout(600);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const base = opt("--base", "http://127.0.0.1:2138");
  const outDir = opt(
    "--out",
    path.join(
      __dirname,
      "..",
      "test",
      "ui-smoke",
      "output",
      "visual-qa-live-output",
    ),
  );
  const strict = args.includes("--strict");
  mkdirSync(outDir, { recursive: true });

  const onboardedSeed = buildOnboardedSeed();
  const matrix = buildStateMatrix();
  const browser = await chromium.launch();
  const reports = [];

  try {
    for (const state of matrix) {
      const vp = VIEWPORTS[state.viewport];
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
        deviceScaleFactor: 2,
      });
      try {
        if (state.seed === "onboarded") {
          await ctx.addInitScript((seed) => {
            for (const [k, v] of Object.entries(seed))
              window.localStorage.setItem(k, v);
          }, onboardedSeed);
        }
        const page = await ctx.newPage();
        const targetUrl = buildCaptureUrl(base, state.route);
        let response;
        try {
          response = await page.goto(targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: 20000,
          });
        } catch (error) {
          throw new Error(
            `Failed to load ${state.id} at ${targetUrl}: ${error?.message ?? error}`,
          );
        }
        if (!response?.ok()) {
          throw new Error(
            `Failed to load ${state.id} at ${targetUrl}: HTTP ${response?.status() ?? "unknown"}`,
          );
        }
        await page
          .waitForLoadState("networkidle", { timeout: 5000 })
          // error-policy:J6 best-effort settle — SPAs holding long-poll/WS
          // connections never reach networkidle; the fixed wait below is the
          // real settle gate and the screenshot still fails loudly on its own.
          .catch(() => {});
        await page.waitForTimeout(1500);
        if (state.focusComposer) await focusAndType(page);

        const file = path.join(outDir, `${state.id}.png`);
        await page.screenshot({ path: file });
        const report = await analyzeScreenshot(file, {});
        const entry = {
          id: state.id,
          route: state.route,
          seed: state.seed,
          image: file,
          size: report.size,
          dominant_palette: report.dominant_palette,
          color_fractions: report.color_fractions,
          ocr_text: (report.ocr_text || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 240),
        };
        reports.push(entry);
        const measured = entry.color_fractions?.blue_fraction;
        const blue = Number.isFinite(measured)
          ? measured.toFixed(3)
          : "unmeasured";
        console.log(
          `■ ${state.id.padEnd(26)} blue=${blue}  ${entry.ocr_text.slice(0, 70)}`,
        );
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }

  const seedDeltas = [];
  for (const vpName of Object.keys(VIEWPORTS)) {
    const gate = reports.find((r) => r.id === `${vpName}-onboarding`);
    const shell = reports.find((r) => r.id === `${vpName}-shell`);
    if (!gate || !shell) continue;
    const delta = await changeMetric(shell.image, gate.image);
    seedDeltas.push({
      viewport: vpName,
      changedFraction: delta.changed_fraction,
    });
  }
  const driftOffenders = seedDriftOffenders(seedDeltas);
  if (driftOffenders.length) {
    throw new Error(
      `Onboarded seed did not take effect — seeded shell renders the onboarding gate's pixels: ${driftOffenders
        .map((o) => `${o.viewport} (changed_fraction=${o.changedFraction})`)
        .join(", ")}`,
    );
  }

  const verdict = aggregateVerdict(reports);
  writeFileSync(
    path.join(outDir, "report.json"),
    JSON.stringify({ base, verdict, seedDeltas, reports }, null, 2),
  );
  console.log(
    `\n${verdict.pass ? "PASS" : "FAIL"} — no-blue invariant (ceiling ${verdict.blueCeiling}); ${reports.length} states → ${outDir}/report.json`,
  );
  if (verdict.offenders.length)
    console.log(
      `  offenders: ${verdict.offenders
        .map(
          (o) => `${o.id}=${o.blue == null ? "unmeasured" : o.blue.toFixed(3)}`,
        )
        .join(", ")}`,
    );

  if (strict && !verdict.pass) process.exit(1);
}

// Only run when invoked directly, so the pure helpers stay importable by tests.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
