import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Chat / touch / gesture coverage gate (#12188, vitest, boot-free).
 *
 * Sibling to launcher-view-coverage.test.ts and view-interaction-coverage.test.ts:
 * those pin per-view coverage; this pins per-GESTURE-HANDLER-SITE coverage. A
 * handler site is a shell component that wires one of the four real-gesture
 * primitives (usePullGesture / useNotificationPull / useHorizontalPager /
 * useConversationSwipeJank). Wiring a primitive into a new shell component
 * without a CHAT_GESTURE_MATRIX row FAILS here — the core acceptance criterion of
 * #12188 phase 1 ("CI fails when a covered handler site is added without a matrix
 * row").
 *
 * The gate DISCOVERS handler sites straight from source — it greps the shell
 * component tree for hook-call sites of the four primitives — so the matrix
 * cannot drift from what actually ships. It then asserts every discovered site
 * has a matrix row, every row maps to a still-live site, and every runner/spec
 * file the rows reference exists on disk.
 *
 * Human-readable table + level/evidence-lane notes: docs/CHAT_GESTURE_COVERAGE.md.
 *
 * Boot-free by design (file reads + set diffs), like its siblings, so it runs on
 * every PR in the cheap test:client lane instead of behind a cold-renderer boot.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const SHELL_DIR = path.join(
  REPO_ROOT,
  "packages",
  "ui",
  "src",
  "components",
  "shell",
);

/**
 * The four real-gesture primitives. A shell component that CALLS one of these
 * binds a real touch/pointer gesture to a shipped surface — that is a handler
 * site the matrix must cover. Keep in sync with the modules under
 * packages/ui/src/components/shell/ + packages/ui/src/hooks/ and the doc's
 * "What a gesture-handler site means" table.
 */
const GESTURE_PRIMITIVES = [
  "usePullGesture",
  "useNotificationPull",
  "useHorizontalPager",
  "useConversationSwipeJank",
] as const;

// Matches a hook CALL site (optionally with a generic type arg), e.g.
// `usePullGesture({…})` or `useHorizontalPager<HTMLElement>({…})` — not a bare
// import or a type reference.
const PRIMITIVE_CALL_RE = new RegExp(
  `\\b(${GESTURE_PRIMITIVES.join("|")})(<[^>]*>)?\\(`,
);

/** The primitive-hook module basenames — a call INSIDE these is the definition, not a site. */
const PRIMITIVE_MODULE_BASENAMES = new Set([
  "use-pull-gesture.ts",
  "use-notification-pull.ts",
]);

interface GestureHandlerCoverage {
  /** Primitives the site wires (asserted below to actually appear in its source). */
  primitives: readonly (typeof GESTURE_PRIMITIVES)[number][];
  /** L1 primitive-unit tests (repo-relative). */
  l1: readonly string[];
  /** L2 hasTouch-fixture e2e runners (repo-relative). */
  l2: readonly string[];
  /**
   * L3 app CDP-emulation matrix spec (repo-relative), or null when the surface is
   * an in-thread affordance covered by app-level smoke rather than a dedicated
   * matrix leg.
   */
  l3: string | null;
  /** Real-device platform spec (repo-relative), or null (see l3). */
  platform: string | null;
}

const UI = "packages/ui/src";
const APP = "packages/app/test";

/**
 * The checked-in gesture-handler coverage inventory. Every discovered handler
 * site (a shell component calling a gesture primitive) MUST appear here, keyed by
 * its component file basename. Human-readable table: docs/CHAT_GESTURE_COVERAGE.md.
 */
const CHAT_GESTURE_MATRIX: Record<string, GestureHandlerCoverage> = {
  "ContinuousChatOverlay.tsx": {
    primitives: ["usePullGesture", "useConversationSwipeJank"],
    l1: [
      `${UI}/components/shell/use-pull-gesture.test.ts`,
      `${UI}/hooks/useConversationSwipeJank.test.ts`,
    ],
    l2: [
      `${UI}/components/shell/__e2e__/run-chat-sheet-e2e.mjs`,
      `${UI}/components/shell/__e2e__/run-conversation-swipe-e2e.mjs`,
    ],
    l3: `${APP}/ui-smoke/gesture-matrix.spec.ts`,
    platform: `${APP}/android/touch-gesture.android.spec.ts`,
  },
  "HomeLauncherSurface.tsx": {
    primitives: ["useHorizontalPager"],
    l1: [
      `${UI}/hooks/useHorizontalPager.test.ts`,
      `${UI}/hooks/useHorizontalPager.test.tsx`,
    ],
    l2: [`${UI}/components/shell/__e2e__/run-home-screen-e2e.mjs`],
    l3: `${APP}/ui-smoke/gesture-matrix.spec.ts`,
    platform: `${APP}/android/touch-gesture.android.spec.ts`,
  },
  "HomeScreen.tsx": {
    primitives: ["usePullGesture", "useNotificationPull"],
    l1: [
      `${UI}/components/shell/use-pull-gesture.test.ts`,
      `${UI}/components/shell/use-notification-pull.test.ts`,
    ],
    l2: [`${UI}/components/shell/__e2e__/run-home-screen-e2e.mjs`],
    l3: `${APP}/ui-smoke/gesture-matrix.spec.ts`,
    platform: `${APP}/android/touch-gesture.android.spec.ts`,
  },
  "TopicGroup.tsx": {
    primitives: ["usePullGesture"],
    l1: [`${UI}/components/shell/use-pull-gesture.test.ts`],
    l2: [`${UI}/components/shell/__e2e__/run-chatux-gesture-e2e.mjs`],
    // In-thread affordance — rides app-level chat smoke, no dedicated L3/device leg.
    l3: null,
    platform: null,
  },
};

/** The two real-touch helper contracts the doc requires stay SPLIT (L2 vs L3). */
const HAS_TOUCH_FIXTURE_HELPER = `${UI}/testing/real-touch-gestures.ts`;
const CDP_EMULATION_APP_HELPER = `${APP}/ui-smoke/helpers/real-touch-gestures.ts`;

/** Recursively list `.tsx`/`.ts` source files under `dir`, skipping tests/fixtures. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      // __e2e__ holds fixtures + runners (drivers, not shipped handler sites).
      if (entry === "__e2e__" || entry === "__tests__") continue;
      out.push(...listSourceFiles(abs));
      continue;
    }
    if (!/\.(tsx|ts)$/.test(entry)) continue;
    if (/\.test\.(tsx|ts)$/.test(entry) || /\.stub\.(tsx|ts)$/.test(entry)) {
      continue;
    }
    out.push(abs);
  }
  return out;
}

/** Discover handler sites: shell source files that CALL a gesture primitive. */
function discoverHandlerSites(): string[] {
  const sites: string[] = [];
  for (const abs of listSourceFiles(SHELL_DIR)) {
    const base = path.basename(abs);
    // The primitive modules themselves contain the hook definition, not a site.
    if (PRIMITIVE_MODULE_BASENAMES.has(base)) continue;
    const source = readFileSync(abs, "utf8");
    if (PRIMITIVE_CALL_RE.test(source)) sites.push(base);
  }
  return sites.sort();
}

function referencedFiles(coverage: GestureHandlerCoverage): string[] {
  return [
    ...coverage.l1,
    ...coverage.l2,
    ...(coverage.l3 ? [coverage.l3] : []),
    ...(coverage.platform ? [coverage.platform] : []),
  ];
}

describe("chat gesture coverage gate", () => {
  it("every discovered gesture-handler site has a matrix row", () => {
    const uncovered = discoverHandlerSites().filter(
      (site) => !(site in CHAT_GESTURE_MATRIX),
    );

    expect(
      uncovered,
      [
        `Shell component(s) wire a gesture primitive without a coverage row: ${uncovered.join(", ")}.`,
        "To fix: (1) add real interaction coverage — a run-*-e2e.mjs fixture runner",
        "(L2) and a gesture-matrix.spec.ts leg (L3) where reachable — then (2) add a",
        "CHAT_GESTURE_MATRIX entry here and a row in",
        "packages/app/docs/CHAT_GESTURE_COVERAGE.md.",
      ].join(" "),
    ).toEqual([]);
  });

  it("matrix has no stale rows (every keyed site is still a handler site)", () => {
    const sites = new Set(discoverHandlerSites());
    const stale = Object.keys(CHAT_GESTURE_MATRIX).filter(
      (site) => !sites.has(site),
    );

    expect(
      stale,
      `CHAT_GESTURE_MATRIX keys components that no longer wire a gesture primitive: ${stale.join(", ")}. Remove them.`,
    ).toEqual([]);
  });

  it("every matrix row's declared primitives actually appear in its component", () => {
    const failures: string[] = [];
    for (const [site, coverage] of Object.entries(CHAT_GESTURE_MATRIX)) {
      const abs = path.join(SHELL_DIR, site);
      if (!existsSync(abs)) {
        failures.push(`${site} does not exist under the shell dir`);
        continue;
      }
      const source = readFileSync(abs, "utf8");
      for (const primitive of coverage.primitives) {
        const callRe = new RegExp(`\\b${primitive}(<[^>]*>)?\\(`);
        if (!callRe.test(source)) {
          failures.push(`${site} does not call ${primitive}`);
        }
      }
      // And the reverse: every primitive the source calls must be declared.
      for (const primitive of GESTURE_PRIMITIVES) {
        const callRe = new RegExp(`\\b${primitive}(<[^>]*>)?\\(`);
        if (callRe.test(source) && !coverage.primitives.includes(primitive)) {
          failures.push(`${site} calls ${primitive} but the row omits it`);
        }
      }
    }

    expect(
      failures,
      `Matrix row primitives out of sync with source: ${failures.join("; ")}.`,
    ).toEqual([]);
  });

  it("every referenced test/runner/spec file exists on disk", () => {
    const missing: string[] = [];
    for (const [site, coverage] of Object.entries(CHAT_GESTURE_MATRIX)) {
      // Every site needs at least L1 + L2 coverage (the automated floor).
      if (coverage.l1.length === 0) missing.push(`${site} has no L1 unit test`);
      if (coverage.l2.length === 0) {
        missing.push(`${site} has no L2 fixture e2e runner`);
      }
      for (const rel of referencedFiles(coverage)) {
        if (!existsSync(path.resolve(REPO_ROOT, rel))) {
          missing.push(`${site} → ${rel}`);
        }
      }
    }

    expect(
      missing,
      `Coverage matrix references files that do not exist (or a site missing its L1/L2 floor): ${missing.join(", ")}. Fix the path or add the missing test.`,
    ).toEqual([]);
  });

  it("keeps the two real-touch helper contracts split (hasTouch fixtures vs CDP-emulation app specs)", () => {
    const fixtureHelper = path.resolve(REPO_ROOT, HAS_TOUCH_FIXTURE_HELPER);
    const appHelper = path.resolve(REPO_ROOT, CDP_EMULATION_APP_HELPER);
    expect(existsSync(fixtureHelper), HAS_TOUCH_FIXTURE_HELPER).toBe(true);
    expect(existsSync(appHelper), CDP_EMULATION_APP_HELPER).toBe(true);
    // They sit at different boundaries (isolated component vs shipped app +
    // compat-click synthesis) and must not be collapsed into one helper.
    expect(
      HAS_TOUCH_FIXTURE_HELPER,
      "the L2 fixture helper and L3 app helper must be two distinct files",
    ).not.toEqual(CDP_EMULATION_APP_HELPER);
  });

  it("covers a stable, non-empty set of gesture-handler sites", () => {
    const sites = discoverHandlerSites();
    // Guards against a bad discovery regex silently emptying the roster (which
    // would make every other assertion trivially pass). This is the current
    // gesture-handler roster; update it (and the doc) when the shell wires a
    // primitive into a new component intentionally.
    expect(sites).toEqual(
      [
        "ContinuousChatOverlay.tsx",
        "HomeLauncherSurface.tsx",
        "HomeScreen.tsx",
        "TopicGroup.tsx",
      ].sort(),
    );
  });
});
