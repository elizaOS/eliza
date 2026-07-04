import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Chat/touch/gesture interaction-coverage gate (#12188, vitest, boot-free).
 *
 * Sibling to launcher-view-coverage.test.ts, but gesture-SPECIFIC: it discovers
 * every gesture-handler site in `packages/ui/src` (files that implement a real
 * pointer/touch gesture — a pointer-capture drag, a custom touch handler, or a
 * gesture-engine hook) and proves each one is accounted for by a row in the
 * checked-in CHAT_GESTURE_MATRIX. That matrix is the enforced twin of
 * docs/CHAT_GESTURE_COVERAGE.md.
 *
 * The core acceptance criterion: adding a NEW gesture-handler site to
 * `packages/ui/src` (a new pointer-capture drag / custom touch handler / gesture
 * hook) without a matrix row FAILS here. The gate stays boot-free (file reads +
 * set diffs) so it runs on every PR in the cheap `test:client` lane, not behind a
 * cold-renderer Playwright boot.
 *
 * What this gate DOES enforce: every discovered gesture site is in a row; the
 * matrix references no renamed/removed site; every referenced test/runner file
 * exists on disk; the discovered roster is stable (a broken predicate can't empty
 * it silently). What it does NOT enforce: that each row actually runs green — that
 * is the L3 runner + ui-smoke + platform lanes' job, tracked per PR_EVIDENCE.md.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const UI_SRC = path.join(REPO_ROOT, "packages/ui/src");

/**
 * A "gesture-handler site" is a source file that registers a real pointer/touch
 * gesture. Three low-false-positive markers identify one:
 *   1. `setPointerCapture(` — you only capture a pointer to run a drag/pan gesture.
 *   2. a custom touch registration — `onTouchStart` / `addEventListener("touchstart"`
 *      / `.on("touchstart"` (a hand-rolled touch gesture, not a click).
 *   3. a named gesture-engine hook — usePullGesture / useHorizontalPager /
 *      useNotificationPull / useConversationSwipeJank (definition or consumer).
 * A plain `onClick`/`onPointerDown` button is intentionally NOT a gesture site.
 */
const GESTURE_MARKERS: readonly RegExp[] = [
  /\.setPointerCapture\s*\(/,
  /onTouchStart[=\s{]/,
  /addEventListener\(\s*["']touchstart/,
  /\bon\(\s*["']touchstart/,
  /\buse(PullGesture|HorizontalPager|NotificationPull|ConversationSwipeJank)\b/,
];

/** `.test.`/`.fuzz.` specs, `__e2e__` fixtures, and this gate are not sites. */
function isGestureSiteCandidate(fileName: string): boolean {
  if (!/\.(ts|tsx)$/.test(fileName)) return false;
  if (/\.test\.(ts|tsx)$/.test(fileName)) return false;
  if (/\.fuzz\.(ts|tsx)$/.test(fileName)) return false;
  if (/mechanics-regression-gate/.test(fileName)) return false;
  return true;
}

/** Walk `packages/ui/src` and return repo-relative gesture-handler site paths. */
function discoverGestureSites(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        // `testing/` is gesture-test scaffolding (fixture models, real-touch
        // helpers, the e2e-runner toolkit) — not product gesture handlers — so
        // it is excluded like `__e2e__`; a marker name appearing in its prose
        // (e.g. a `useHorizontalPager` mention in a sim-model comment) is not a
        // handler site.
        if (
          entry === "node_modules" ||
          entry === "__e2e__" ||
          entry === "testing"
        )
          continue;
        walk(abs);
        continue;
      }
      if (!isGestureSiteCandidate(entry)) continue;
      const source = readFileSync(abs, "utf8");
      if (GESTURE_MARKERS.some((marker) => marker.test(source))) {
        found.push(path.relative(REPO_ROOT, abs));
      }
    }
  };
  walk(UI_SRC);
  return found.sort();
}

interface GestureRow {
  /** Matrix row number (1–18), matching docs/CHAT_GESTURE_COVERAGE.md. */
  id: number;
  /** The interaction under test. */
  interaction: string;
  /**
   * The `packages/ui/src` handler files this row governs. Every entry MUST be a
   * discovered gesture site (asserted), and the union across all rows MUST cover
   * every discovered site. Rows for interactions whose handler is not a
   * pointer/touch gesture (timer-based push-to-talk, attachment paste, slash
   * menu, keyboard-avoidance layout math) carry no sites — their handler files
   * are noted in the doc and covered by the `tests` below.
   */
  sites: string[];
  /** Test/runner files that cover the row. Each MUST exist on disk. */
  tests: string[];
  /** Set when the row's tests are owned by a companion issue (e.g. #12179). */
  ownedBy?: string;
}

const S = (p: string) => `packages/ui/src/${p}`;
const OVERLAY = S("components/shell/ContinuousChatOverlay.tsx");
const CHAT_SHEET_RUNNER = S("components/shell/__e2e__/run-chat-sheet-e2e.mjs");
const GESTURE_MATRIX_SPEC = "packages/app/test/ui-smoke/gesture-matrix.spec.ts";
const ANDROID_TOUCH_SPEC =
  "packages/app/test/android/touch-gesture.android.spec.ts";

/**
 * The checked-in chat/touch/gesture coverage matrix. Human-readable table +
 * level/platform legend: docs/CHAT_GESTURE_COVERAGE.md. Keep the two in sync —
 * this is the roster the gate enforces.
 */
const CHAT_GESTURE_MATRIX: readonly GestureRow[] = [
  {
    id: 1,
    interaction: "Sheet drag detents (pill↔input↔full), flick vs slow drag",
    sites: [S("components/shell/use-pull-gesture.ts"), OVERLAY],
    tests: [
      S("components/shell/chat-panel-layout.test.ts"),
      S("components/shell/use-pull-gesture.test.ts"),
      CHAT_SHEET_RUNNER,
      GESTURE_MATRIX_SPEC,
    ],
  },
  {
    id: 2,
    interaction: "Conversation edge-swipe L/R (+ jank telemetry)",
    sites: [
      OVERLAY,
      S("hooks/useConversationSwipeJank.ts"),
      S("components/shell/use-pull-gesture.ts"),
    ],
    tests: [
      S("hooks/useConversationSwipeJank.test.ts"),
      S("components/shell/__e2e__/run-conversation-swipe-e2e.mjs"),
    ],
  },
  {
    id: 3,
    interaction: "Long-press copy on message (420 ms, move-cancel)",
    sites: [OVERLAY],
    tests: [CHAT_SHEET_RUNNER],
  },
  {
    id: 4,
    interaction: "Tap-reveal action row (touch) / hover rail (desktop)",
    sites: [S("components/composites/chat/chat-message.tsx")],
    tests: [S("components/composites/chat/chat-message.tap-reveal.test.tsx")],
  },
  {
    id: 5,
    interaction: "Long-press conversation item → context menu (450 ms)",
    // The long-press recognizer was extracted into the shared usePressAndHold
    // hook (#12179/#12290); chat-conversation-item.tsx now spreads its handlers
    // and no longer carries a raw touch marker, so the hook is the site.
    sites: [S("gestures/usePressAndHold.ts")],
    tests: [
      S("components/composites/chat/chat-conversation-item.test.tsx"),
      S("gestures/gestures.test.ts"),
    ],
  },
  {
    id: 6,
    interaction: "Push-to-talk hold (composer + overlay mic)",
    sites: [S("hooks/usePushToTalk.ts")],
    tests: [
      S("components/composites/chat/chat-composer.test.tsx"),
      S("hooks/usePushToTalk.test.tsx"),
    ],
  },
  {
    id: 7,
    interaction: "Tap-outside collapse; drag-vs-tap slop; scrim click-through",
    sites: [OVERLAY],
    tests: [GESTURE_MATRIX_SPEC],
  },
  {
    id: 8,
    interaction: "Notification pull / pull-to-refresh; ghost-click gate",
    sites: [
      S("components/shell/use-notification-pull.ts"),
      S("components/shell/HomeScreen.tsx"),
    ],
    tests: [
      S("components/shell/use-notification-pull.test.ts"),
      GESTURE_MATRIX_SPEC,
      ANDROID_TOUCH_SPEC,
    ],
  },
  {
    id: 9,
    interaction: "Home↔launcher pager swipe, nested-pager arbitration",
    sites: [
      S("hooks/useHorizontalPager.ts"),
      S("components/shell/HomeLauncherSurface.tsx"),
      S("components/shell/HomeScreen.tsx"),
    ],
    tests: [
      S("hooks/useHorizontalPager.test.ts"),
      GESTURE_MATRIX_SPEC,
      S("components/shell/__e2e__/run-home-screen-e2e.mjs"),
      S("components/shell/HomeLauncherSurface.test.tsx"),
      ANDROID_TOUCH_SPEC,
    ],
    ownedBy: "#12179",
  },
  {
    id: 10,
    interaction: "Topic group flick collapse/expand",
    sites: [S("components/shell/TopicGroup.tsx")],
    tests: [S("components/shell/__e2e__/run-chatux-gesture-e2e.mjs")],
  },
  {
    id: 11,
    interaction: "Send/stop/edit/delete/retry; streaming render; typing phases",
    sites: [OVERLAY],
    tests: [CHAT_SHEET_RUNNER],
  },
  {
    id: 12,
    interaction:
      "Attachments: add/paste/remove outbound; open/lightbox inbound",
    sites: [],
    tests: [S("components/chat/MessageAttachments.test.tsx")],
  },
  {
    id: 13,
    interaction: "Keyboard avoidance (visualViewport vs native lift)",
    sites: [],
    tests: [S("components/shell/chat-panel-layout.test.ts")],
  },
  {
    id: 14,
    interaction: "Auto-scroll at bottom vs reading-scrollback",
    sites: [OVERLAY],
    tests: [CHAT_SHEET_RUNNER],
  },
  {
    id: 15,
    interaction: "Kiosk window drag; sidebar/panel resize drags",
    sites: [
      S("components/shell/KioskViewCanvas.tsx"),
      S("components/chat/TasksEventsPanel.tsx"),
      S("components/composites/sidebar/sidebar-root.tsx"),
    ],
    tests: [S("components/shell/KioskViewCanvas.gestures.test.tsx")],
  },
  {
    id: 16,
    interaction: "Graph pan/pinch/wheel-zoom",
    sites: [S("components/pages/RelationshipsGraphPanel.tsx")],
    tests: [],
  },
  {
    id: 17,
    interaction: "Slash menu open/dismiss (incl. outside pointerdown)",
    sites: [],
    tests: [
      S("components/shell/ContinuousChatOverlay.slash.test.tsx"),
      S("components/chat/MessageContent.slash-command.test.tsx"),
    ],
  },
  {
    id: 18,
    interaction:
      "Pinch/dblclick on chat surface (should NOT zoom/break layout)",
    sites: [OVERLAY],
    tests: [],
  },
];

function rosteredSites(): Set<string> {
  return new Set(CHAT_GESTURE_MATRIX.flatMap((row) => row.sites));
}

/**
 * The current gesture-handler-site roster. Pinned so a broken discovery predicate
 * (which would empty the set and make every other assertion trivially pass) is
 * caught. Update this and docs/CHAT_GESTURE_COVERAGE.md together when a gesture
 * site is intentionally added or removed.
 */
const PINNED_GESTURE_SITES: readonly string[] = [
  "packages/ui/src/components/chat/TasksEventsPanel.tsx",
  "packages/ui/src/components/composites/chat/chat-message.tsx",
  "packages/ui/src/components/composites/sidebar/sidebar-root.tsx",
  "packages/ui/src/components/pages/RelationshipsGraphPanel.tsx",
  "packages/ui/src/components/shell/ContinuousChatOverlay.tsx",
  "packages/ui/src/components/shell/HomeLauncherSurface.tsx",
  "packages/ui/src/components/shell/HomeScreen.tsx",
  "packages/ui/src/components/shell/KioskViewCanvas.tsx",
  "packages/ui/src/components/shell/TopicGroup.tsx",
  "packages/ui/src/components/shell/use-notification-pull.ts",
  "packages/ui/src/components/shell/use-pull-gesture.ts",
  "packages/ui/src/gestures/usePressAndHold.ts",
  "packages/ui/src/hooks/useConversationSwipeJank.ts",
  "packages/ui/src/hooks/useHorizontalPager.ts",
  "packages/ui/src/hooks/usePushToTalk.ts",
];

describe("chat gesture coverage gate", () => {
  it("every gesture-handler site in packages/ui/src is covered by a matrix row", () => {
    const rostered = rosteredSites();
    const uncovered = discoverGestureSites().filter(
      (site) => !rostered.has(site),
    );

    expect(
      uncovered,
      [
        `Gesture-handler site(s) with no CHAT_GESTURE_MATRIX row: ${uncovered.join(", ")}.`,
        "To fix: add the file to the `sites` of the matrix row whose interaction it",
        "implements (or a new row), and add the row to",
        "packages/app/docs/CHAT_GESTURE_COVERAGE.md. A new gesture must ship its",
        "coverage.",
      ].join(" "),
    ).toEqual([]);
  });

  it("the matrix references no unknown or renamed gesture-handler sites", () => {
    const discovered = new Set(discoverGestureSites());
    const stale = [...rosteredSites()].filter((site) => !discovered.has(site));

    expect(
      stale,
      `CHAT_GESTURE_MATRIX lists site(s) that are no longer discovered gesture handlers (renamed, deleted, or no longer using a gesture marker): ${stale.join(", ")}. Update the matrix.`,
    ).toEqual([]);
  });

  it("every referenced test/runner file exists on disk", () => {
    const missing: string[] = [];
    for (const row of CHAT_GESTURE_MATRIX) {
      for (const file of row.tests) {
        if (!existsSync(path.resolve(REPO_ROOT, file))) {
          missing.push(`row ${row.id} → ${file}`);
        }
      }
    }

    expect(
      missing,
      `Matrix references test/runner files that do not exist: ${missing.join(", ")}. Fix the path or add the missing test.`,
    ).toEqual([]);
  });

  it("covers a stable, non-empty roster of gesture-handler sites", () => {
    // Guards against a bad predicate silently emptying the discovered set (which
    // would make the "every site is covered" assertion trivially pass).
    expect(discoverGestureSites()).toEqual([...PINNED_GESTURE_SITES]);
  });

  it("matrix row ids are the unique contiguous range 1..N", () => {
    const ids = CHAT_GESTURE_MATRIX.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(
      Array.from({ length: ids.length }, (_, index) => index + 1),
    );
  });
});
