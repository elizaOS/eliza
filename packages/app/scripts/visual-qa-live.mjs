#!/usr/bin/env node
/**
 * Live visual-QA sweep against a running dashboard dev server. Complements the
 * heavier `audit:app` (which prebuilds every plugin-view bundle and walks the
 * full route matrix): this tool points a headless Chromium at an *already
 * running* server, captures a small matrix of the states that actually matter
 * for the MVP — the first-run home/onboarding prompt, the keyboard-adjacent
 * mobile composer, and (by seeding a session) the post-onboarding shell + its
 * designed degraded renders — and runs each capture through the repo's own
 * `visual-qa.mjs` analyzer (OCR + dominant palette + brand-colour fractions).
 * One report.json + a terminal summary come out; `--strict` turns the
 * brand-colour invariant ("no blue", elizaOS orange is accent-only) into a
 * non-zero exit so a lane can gate on it.
 *
 * Why seeding: first-run local state changes which product surface renders.
 * Injecting the canonical `steward_session_token` +
 * `eliza:first-run-complete=1` into an *isolated* Playwright context (its own
 * localStorage — it never touches the running server's state or other users)
 * lets the sweep reach the post-onboarding shell and, when no backend is
 * reachable, the designed failure state — which is the three-state-rule render
 * worth verifying (see #14415).
 *
 * Consumed by: an operator or coding agent doing a fast pre-PR visual pass
 * without the multi-minute `audit:app` prebuild. Not a CI gate unless a lane
 * opts in with `--strict`.
 *
 * Usage:
 *   node scripts/visual-qa-live.mjs --base http://127.0.0.1:2138 [--out DIR] [--strict]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { analyzeScreenshot, changeMetric } from "./lib/visual-qa.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
export const COMPOSER_PROBE_TEXT = "remind me to call the pharmacy before 5";
const FIRST_RUN_EXPECTED_ANY_TEXT = [
  "Swipe for apps",
  "Sign in to Eliza Cloud",
];
const SHELL_EXPECTED_ANY_TEXT = ["Settings", "Backend Unreachable"];
const CHAT_EXPECTED_ANY_TEXT = ["Pull chat up", "Backend Unreachable"];

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
 * (fresh = first-run home prompt, onboarded = seeded shell), a route, and an
 * optional `focusComposer` step to exercise the keyboard-adjacent mobile
 * layout.
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
      expectedAnyTextIncludes: FIRST_RUN_EXPECTED_ANY_TEXT,
    });
    states.push({
      id: `${vpName}-shell`,
      viewport: vpName,
      seed: "onboarded",
      route: "/views",
      expectedAnyTextIncludes: SHELL_EXPECTED_ANY_TEXT,
    });
    states.push({
      id: `${vpName}-chat`,
      viewport: vpName,
      seed: "onboarded",
      route: "/chat",
      expectedAnyTextIncludes: CHAT_EXPECTED_ANY_TEXT,
    });
    if (vp.isMobile) {
      states.push({
        id: `${vpName}-onboarding-composer-focused`,
        viewport: vpName,
        seed: "fresh",
        route: "/",
        focusComposer: true,
        expectedAnyTextIncludes: FIRST_RUN_EXPECTED_ANY_TEXT,
        expectedComposerText: COMPOSER_PROBE_TEXT,
      });
      states.push({
        id: `${vpName}-composer-focused`,
        viewport: vpName,
        seed: "onboarded",
        route: "/chat",
        focusComposer: true,
        expectedAnyTextIncludes: CHAT_EXPECTED_ANY_TEXT,
        expectedComposerText: COMPOSER_PROBE_TEXT,
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
 * startup boundary), every "seeded" capture silently re-renders the first-run
 * surface and the sweep passes on the wrong pixels. Requiring the first-run
 * surface and the seeded shell to differ materially per viewport turns that
 * silent drift into a hard failure. `deltas` is
 * `[{ viewport, changedFraction }]` from `changeMetric`.
 */
export function seedDriftOffenders(deltas, { minChangedFraction = 0.02 } = {}) {
  return deltas
    .filter((d) => !(d.changedFraction > minChangedFraction))
    .map((d) => {
      const offender = {
        viewport: d.viewport,
        changedFraction: d.changedFraction,
      };
      if (d.reason) offender.reason = d.reason;
      return offender;
    });
}

export function buildOverallVerdict({
  colorVerdict,
  captureFailures = [],
  driftOffenders = [],
}) {
  return {
    pass:
      Boolean(colorVerdict?.pass) &&
      captureFailures.length === 0 &&
      driftOffenders.length === 0,
    colorPass: Boolean(colorVerdict?.pass),
    captureFailures,
    driftOffenders,
  };
}

function normalizeVisibleText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function includesText(haystack, needle) {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function matchesExpectedDomText(state, normalizedDomText) {
  const required = state.expectedTextIncludes ?? [];
  const any = state.expectedAnyTextIncludes ?? [];
  return (
    required.every((text) => includesText(normalizedDomText, text)) &&
    (any.length === 0 ||
      any.some((text) => includesText(normalizedDomText, text)))
  );
}

export function evaluateCaptureReadiness({
  state,
  domText = "",
  composerText = "",
  minDomTextLength = 12,
}) {
  const checks = [];
  let pass = true;
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail });
    if (!ok) pass = false;
  };
  const normalizedDomText = normalizeVisibleText(domText);
  check(
    "dom:not_blank",
    normalizedDomText.length >= minDomTextLength,
    `visible DOM text length ${normalizedDomText.length} (min ${minDomTextLength})`,
  );
  for (const expected of state.expectedTextIncludes ?? []) {
    check(
      "dom:expected_text",
      includesText(normalizedDomText, expected),
      `visible DOM text ${includesText(normalizedDomText, expected) ? "contains" : "does not contain"} "${expected}"`,
    );
  }
  const expectedAny = state.expectedAnyTextIncludes ?? [];
  if (expectedAny.length) {
    const matched = expectedAny.filter((expected) =>
      includesText(normalizedDomText, expected),
    );
    check(
      "dom:expected_any_text",
      matched.length > 0,
      matched.length
        ? `visible DOM text contains "${matched[0]}"`
        : `visible DOM text does not contain any of ${expectedAny
            .map((text) => `"${text}"`)
            .join(", ")}`,
    );
  }
  if (state.expectedComposerText) {
    check(
      "composer:typed_text_present",
      composerText.includes(state.expectedComposerText),
      `composer text ${composerText.includes(state.expectedComposerText) ? "contains" : "does not contain"} the probe`,
    );
  }
  return { pass, checks };
}

async function clickOpenAppIfVisible(page, { timeout = 500 } = {}) {
  const candidates = [
    page.getByRole("button", { name: /^Open App$/ }).first(),
    page.getByText(/^Open App$/).first(),
  ];
  for (const openApp of candidates) {
    if (
      !(await openApp.isVisible({ timeout }).catch(() => {
        // error-policy:J4 absence of the startup recovery affordance simply
        // means the screen is either already past that boundary or still
        // settling; the composer check remains the authoritative proof.
        return false;
      }))
    ) {
      continue;
    }
    await openApp.click({ timeout: 2000 });
    await page.waitForTimeout(1000);
    return true;
  }
  return false;
}

async function focusAndType(page) {
  await clickOpenAppIfVisible(page);
  const box = page.locator('[data-testid="chat-composer-textarea"]').first();
  try {
    await box.waitFor({ state: "visible", timeout: 5000 });
  } catch (error) {
    const recovered = await clickOpenAppIfVisible(page, { timeout: 5000 });
    if (!recovered) throw error;
    await box.waitFor({ state: "visible", timeout: 10000 });
  }
  await box.click({ timeout: 4000 });
  await box.type(COMPOSER_PROBE_TEXT, { delay: 8 });
  await page.waitForTimeout(600);
}

async function readVisibleText(page, state, { minLength = 12 } = {}) {
  const deadline = Date.now() + 12_000;
  let lastText = "";
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      lastText = normalizeVisibleText(
        await page.locator("body").innerText({ timeout: 1000 }),
      );
      if (
        lastText.length >= minLength &&
        matchesExpectedDomText(state, lastText)
      ) {
        return lastText;
      }
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(250);
  }
  if (lastError) {
    throw new Error(
      `Failed to read visible DOM text for ${state.id}: ${lastError?.message ?? lastError}`,
    );
  }
  return lastText;
}

async function readComposerText(page) {
  const box = page.locator('[data-testid="chat-composer-textarea"]').first();
  await box.waitFor({ state: "visible", timeout: 4000 });
  return box.evaluate((el) =>
    "value" in el ? String(el.value) : String(el.textContent ?? ""),
  );
}

function compactError(error) {
  return String(error?.message ?? error)
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function buildCaptureFailureEntry({ state, targetUrl, error, failureImage }) {
  const detail = compactError(error);
  return {
    id: state.id,
    route: state.route,
    seed: state.seed,
    target_url: targetUrl,
    image: failureImage,
    capture_error: detail,
    visual_verdict: "fail",
    visual_checks: [
      { name: "capture:completed", ok: false, detail },
      {
        name: "brand:no_blue",
        ok: false,
        detail: "blue_fraction not measured because capture failed",
      },
    ],
    network_idle: "not reached",
    dom_checks: [{ name: "capture:completed", ok: false, detail }],
    dom_text: "",
    ocr_text: "",
    ocr_note: "capture failed before OCR",
  };
}

function gitValue(args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // error-policy:J7 provenance enrichment must never kill a local visual pass;
    // the report records null so reviewers can see metadata was unavailable.
    return null;
  }
}

function buildRunMeta({ base, outDir, strict, stateCount }) {
  return {
    createdAt: new Date().toISOString(),
    base,
    outDir,
    strict,
    stateCount,
    commit: gitValue(["rev-parse", "HEAD"]),
    branch: gitValue(["branch", "--show-current"]),
  };
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
  const meta = buildRunMeta({
    base,
    outDir,
    strict,
    stateCount: matrix.length,
  });
  const browser = await chromium.launch();
  const reports = [];
  const captureFailures = [];

  try {
    for (const state of matrix) {
      const vp = VIEWPORTS[state.viewport];
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
        deviceScaleFactor: 2,
      });
      let page = null;
      const targetUrl = buildCaptureUrl(base, state.route);
      try {
        if (state.seed === "onboarded") {
          await ctx.addInitScript((seed) => {
            for (const [k, v] of Object.entries(seed))
              window.localStorage.setItem(k, v);
          }, onboardedSeed);
        }
        page = await ctx.newPage();
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
        let networkIdle = "reached";
        try {
          await page.waitForLoadState("networkidle", { timeout: 5000 });
        } catch (error) {
          // error-policy:J4 a dev server without an API often keeps failed proxy
          // requests noisy; screenshot validity is checked by DOM and image
          // analysis below, so a timeout is recorded instead of hidden.
          networkIdle = `timeout: ${String(error?.message ?? error).slice(0, 120)}`;
        }
        await page.waitForTimeout(1500);
        let focusError = "";
        if (state.focusComposer) {
          try {
            await focusAndType(page);
          } catch (error) {
            focusError = String(error?.message ?? error).slice(0, 180);
          }
        }
        const domText = await readVisibleText(page, state, {
          minLength: 12,
        });
        let composerText = "";
        if (state.focusComposer && !focusError) {
          try {
            composerText = await readComposerText(page);
          } catch (error) {
            focusError = String(error?.message ?? error).slice(0, 180);
          }
        }
        const readiness = evaluateCaptureReadiness({
          state,
          domText,
          composerText,
        });
        if (focusError) {
          readiness.pass = false;
          readiness.checks.push({
            name: "composer:focus_and_type",
            ok: false,
            detail: focusError,
          });
        }

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
          visual_verdict: report.verdict,
          visual_checks: report.checks,
          network_idle: networkIdle,
          dom_checks: readiness.checks,
          dom_text: domText.slice(0, 240),
          ocr_text: (report.ocr_text || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 240),
          ocr_note: report.ocr_note,
        };
        reports.push(entry);
        if (!readiness.pass) {
          captureFailures.push({
            id: state.id,
            failedChecks: readiness.checks.filter((c) => !c.ok),
          });
        }
        const measured = entry.color_fractions?.blue_fraction;
        const blue = Number.isFinite(measured)
          ? measured.toFixed(3)
          : "unmeasured";
        const invalid = readiness.pass ? "" : " INVALID_CAPTURE";
        console.log(
          `■ ${state.id.padEnd(26)} blue=${blue}${invalid}  ${entry.ocr_text.slice(0, 70)}`,
        );
      } catch (error) {
        const failedCheck = {
          name: "capture:completed",
          ok: false,
          detail: compactError(error),
        };
        const failureFile = path.join(outDir, `${state.id}-failure.png`);
        let failureImage = null;
        if (page && !page.isClosed()) {
          try {
            await page.screenshot({ path: failureFile, fullPage: true });
            failureImage = existsSync(failureFile) ? failureFile : null;
          } catch {
            // error-policy:J7 failure evidence is best-effort; the structured
            // capture_error below is still the observed diagnostic signal.
          }
        }
        reports.push(
          buildCaptureFailureEntry({
            state,
            targetUrl,
            error,
            failureImage,
          }),
        );
        captureFailures.push({ id: state.id, failedChecks: [failedCheck] });
        console.log(
          `x ${state.id.padEnd(26)} capture failed: ${failedCheck.detail}`,
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
    if (!gate?.image || !shell?.image) {
      seedDeltas.push({
        viewport: vpName,
        changedFraction: undefined,
        reason: "missing onboarding or shell capture",
      });
      continue;
    }
    try {
      const delta = await changeMetric(shell.image, gate.image);
      seedDeltas.push({
        viewport: vpName,
        changedFraction: delta.changed_fraction,
      });
    } catch (error) {
      seedDeltas.push({
        viewport: vpName,
        changedFraction: undefined,
        reason: `change metric failed: ${compactError(error)}`,
      });
    }
  }
  const driftOffenders = seedDriftOffenders(seedDeltas);
  const verdict = aggregateVerdict(reports);
  const overall = buildOverallVerdict({
    colorVerdict: verdict,
    captureFailures,
    driftOffenders,
  });
  writeFileSync(
    path.join(outDir, "report.json"),
    JSON.stringify(
      {
        meta,
        overall,
        verdict,
        seedDeltas,
        captureFailures,
        driftOffenders,
        reports,
      },
      null,
      2,
    ),
  );
  console.log(
    `\n${overall.pass ? "PASS" : "FAIL"} — live visual QA; no-blue=${verdict.pass ? "pass" : "fail"} (ceiling ${verdict.blueCeiling}); ${reports.length} states → ${outDir}/report.json`,
  );
  if (verdict.offenders.length)
    console.log(
      `  offenders: ${verdict.offenders
        .map(
          (o) => `${o.id}=${o.blue == null ? "unmeasured" : o.blue.toFixed(3)}`,
        )
        .join(", ")}`,
    );
  if (captureFailures.length)
    console.log(
      `  invalid captures: ${captureFailures
        .map((f) => `${f.id} (${f.failedChecks.map((c) => c.name).join(", ")})`)
        .join(", ")}`,
    );
  if (driftOffenders.length)
    console.log(
      `  seed drift: ${driftOffenders
        .map((o) => `${o.viewport} changed_fraction=${o.changedFraction}`)
        .join(", ")}`,
    );

  if (strict && !overall.pass) process.exit(1);
}

// Only run when invoked directly, so the pure helpers stay importable by tests.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
