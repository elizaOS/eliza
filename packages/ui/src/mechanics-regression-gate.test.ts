/**
 * Source-scanning regression gate for the interaction mechanics (touch-action,
 * pager surfaces): asserts real behavior, not comments, so a deleted class can't
 * leave a green raw-text gate behind. Reads the src tree, no runtime.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// MECHANICS-REGRESSION GATE (#11853 sibling — the mechanics gap)
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS
// The existing `*-gate.test.ts` files are all STYLE gates (no backdrop-blur, no
// focus-ring, no widget-chrome, no will-change). Two production UI bugs slipped
// past EVERY one of them plus manual QA because they were MECHANICS bugs, not
// style bugs — the pixels looked right, the interaction was dead:
//
//   (a) DRAWER-NOT-SCROLLABLE: a Drawer/sheet/dialog shell with a clamped height
//       (`max-h-[..vh]` / `max-h-screen` / `max-h-dvh`) + `flex-col` +
//       `overflow-hidden` but NO inner `overflow-y-auto` scroll region. Content
//       taller than the clamp is simply clipped — unreachable. Nothing visual is
//       wrong; the content just can't be scrolled to.
//
//   (b) BROKEN-SWIPE: a horizontal pager/carousel surface (a `useHorizontalPager`
//       viewport, `onPointerDown`+`onPointerMove` drag surface) that does NOT pin
//       an explicit `touch-action`. The CSS default (`auto`) hands horizontal
//       pans to the browser's own scroll/back gesture, which fires
//       `pointercancel` instead of `pointerup` — so the swipe silently never
//       commits on real touch hardware. (Fixed on develop via `touch-action:
//       pan-y` / `touch-pan-y`; this gate locks that fix so it can't regress.)
//
// These are STATIC scans (no browser, no render) so they run in plain vitest and
// join the same lane as the other `*-gate` tests.
//
// LIMITS (documented intentionally):
//  - Static heuristics, not a layout engine. They cannot prove a container is
//    truly overflowing at runtime; they assert the STRUCTURAL affordance
//    (a scroll region exists / a touch-action is pinned) that the two real bugs
//    were missing. A determined author can still defeat them (e.g. an inline
//    style var). They are a low-false-positive REGRESSION tripwire for the exact
//    shape of the two shipped bugs, targeted at the real surfaces, not a
//    repo-wide noise cannon.
//  - The pager rule is scoped to `useHorizontalPager` consumers (the real swipe
//    surfaces) rather than every `onPointerDown` in the tree, to stay quiet.
//  - The self-test fixtures at the bottom prove each rule FAILS on a planted
//    violation — so the gate can't silently rot into a no-op.

const UI_SRC = import.meta.dirname;

// Strip comments (block, line, and JSX `{/* */}`) BEFORE scanning. Without this,
// an explanatory comment that merely MENTIONS `touch-pan-y` / `overflow-y-auto`
// would satisfy a raw-text gate even after the real class was deleted — a
// false-negative that would let the exact regression through (e.g.
// HomeLauncherSurface.tsx documents `touch-pan-y` in prose). We gate on RENDERED
// code only.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* block */ and {/* jsx */} innards
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // // line (not URLs like http://)
}

function read(rel: string): string {
  return stripComments(readFileSync(join(UI_SRC, rel), "utf8"));
}

// ---------------------------------------------------------------------------
// Rule (a): scrollable-body detector
// ---------------------------------------------------------------------------
// A "clamped scroll shell" is a className that clamps height AND stacks a column
// AND clips overflow. That combination is ONLY safe if some descendant owns a
// scroll region — otherwise the overflow is dead-clipped.
const CLAMPED_HEIGHT =
  /max-h-\[[^\]]*(?:vh|dvh|svh|lvh)[^\]]*\]|max-h-screen|max-h-dvh|max-h-svh|max-h-lvh/;
const FLEX_COL = /\bflex-col\b/;
const CLIP_OVERFLOW = /\boverflow-hidden\b/;
const SCROLL_REGION =
  /overflow-y-auto|overflow-auto|overflow-y-scroll|overflowY/;
// The drawer BODY scroll region is the flex child that grows + can shrink +
// scrolls: `flex-1 ... min-h-0 ... overflow-y-auto` (order-independent). This is
// the specific affordance the drawer-not-scrollable bug removed. Requiring this
// exact triad (rather than "any overflow-y-auto in the file") means an UNRELATED
// scroller elsewhere in the same file (e.g. a small `max-h-48 overflow-y-auto`
// code block) does NOT mask a dead-clipped drawer body.
const DRAWER_SCROLL_BODY = [
  /\bflex-1\b/,
  /\bmin-h-0\b/,
  /\boverflow-y-auto\b|\boverflow-auto\b/,
];

// Pull out every className string literal so the triad below is checked
// PER-ELEMENT, not per-file. A whole-file scan would let three unrelated
// elements (one `flex-1` here, one `min-h-0` there, a decoy `overflow-y-auto`
// elsewhere) collectively satisfy the triad while NO single element is a real
// scroll body — exactly the McpDetailDrawer false-negative. We require all three
// classes on the SAME element.
function classNameLiterals(source: string): string[] {
  const out: string[] = [];
  // className="..." | className='...' | className={`...`} | className={cn("...", ...)}
  const re =
    /className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{cn\(([\s\S]*?)\)\})/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop.
  while ((m = re.exec(source)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** True when SOME single className element carries the full scroll-body triad. */
function hasDrawerScrollBody(source: string): boolean {
  return classNameLiterals(source).some((cls) =>
    DRAWER_SCROLL_BODY.every((re) => re.test(cls)),
  );
}

/**
 * True when `source` contains a clamped+column+clipped shell but NO scroll
 * region anywhere in the same file — i.e. the drawer-not-scrollable shape.
 * File-granular (not per-element) on purpose: a scroll region living in a child
 * component in the SAME file still satisfies the affordance, and cross-file
 * consumer scroll regions are covered by the explicit consumer assertions below.
 */
function hasUnscrollableClampedShell(source: string): boolean {
  const clamped = CLAMPED_HEIGHT.test(source);
  const column = FLEX_COL.test(source);
  const clipped = CLIP_OVERFLOW.test(source);
  const scrolls = SCROLL_REGION.test(source);
  return clamped && column && clipped && !scrolls;
}

// ---------------------------------------------------------------------------
// Rule (b): pinned-touch-action detector
// ---------------------------------------------------------------------------
const USES_PAGER = /useHorizontalPager\b/;
const PINS_TOUCH_ACTION =
  /touchAction\s*:|touch-pan-x|touch-pan-y|touch-none|touch-action\s*:/;

/**
 * True when `source` mounts a horizontal pager (a swipe surface) but never pins
 * a touch-action anywhere — the broken-swipe shape. Scoped to pager consumers
 * (not the hook's own definition file) so a util that only declares the hook
 * isn't flagged.
 */
function hasUnpinnedPagerSwipe(source: string): boolean {
  // The hook DEFINITION file references the name but isn't a swipe SURFACE.
  const isConsumer =
    USES_PAGER.test(source) &&
    !/export function useHorizontalPager/.test(source);
  return isConsumer && !PINS_TOUCH_ACTION.test(source);
}

// ---------------------------------------------------------------------------
// Real surfaces under gate (the exact files that shipped / could reship the bug)
// ---------------------------------------------------------------------------

// (a) drawer/sheet consumers that own a clamped shell and MUST expose scroll.
//     The shared Drawer primitive (`cloud-ui/components/drawer.tsx`) is a
//     pass-through `{children}` shell — it CANNOT own the scroll region itself,
//     so scroll ownership lives with each consumer. We assert the real consumer
//     that clamps height (`McpDetailDrawer`) keeps its inner scroll body.
const DRAWER_SCROLL_CONSUMERS = ["cloud/mcps/McpDetailDrawer.tsx"] as const;

// (b) pager/swipe surfaces that MUST pin a touch-action.
const PAGER_SWIPE_SURFACES = [
  "components/pages/Launcher.tsx",
  "components/shell/HomeLauncherSurface.tsx",
] as const;

describe("mechanics-regression gate (#11853 sibling)", () => {
  it("(a) drawer/sheet consumers with a clamped shell expose an inner scroll region", () => {
    const offenders: string[] = [];
    for (const rel of DRAWER_SCROLL_CONSUMERS) {
      const src = read(rel);
      // The consumer must both clamp height (proving it's the clamped-shell
      // shape) AND own a genuine scroll BODY (flex-1 + min-h-0 + overflow-y-auto
      // co-located, per hasDrawerScrollBody) — not merely some unrelated
      // scroller elsewhere in the file — otherwise its content dead-clips.
      const clamps = CLAMPED_HEIGHT.test(src);
      const hasBody = hasDrawerScrollBody(src);
      if (clamps && !hasBody) {
        offenders.push(
          `${rel} — clamps height but has no flex-1/min-h-0/overflow-y-auto scroll body`,
        );
      }
    }
    expect(
      offenders,
      `drawer/sheet content must be scrollable, not dead-clipped: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("(b) horizontal pager/swipe surfaces pin an explicit touch-action", () => {
    const offenders: string[] = [];
    for (const rel of PAGER_SWIPE_SURFACES) {
      const src = read(rel);
      if (hasUnpinnedPagerSwipe(src)) {
        offenders.push(
          `${rel} — mounts useHorizontalPager but pins no touch-action (browser will steal the horizontal pan → dead swipe)`,
        );
      }
    }
    expect(
      offenders,
      `swipe surfaces must pin touch-action (pan-y/none) or the browser eats the gesture: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // SELF-TESTS: prove each detector actually FIRES on the bug shape. Without
  // these the gate could silently degrade to always-green if a refactor broke a
  // regex. These fixtures are the two real bugs, distilled.
  // -------------------------------------------------------------------------
  it("self-test: the drawer-not-scrollable shape is detected", () => {
    const buggy = `<DrawerContent className="max-h-[88vh] flex flex-col overflow-hidden">{body}</DrawerContent>`;
    const fixed = `<DrawerContent className="max-h-[88vh] flex flex-col overflow-hidden"><div className="flex-1 min-h-0 overflow-y-auto">{body}</div></DrawerContent>`;
    expect(hasUnscrollableClampedShell(buggy)).toBe(true);
    expect(hasUnscrollableClampedShell(fixed)).toBe(false);
  });

  it("self-test: a DECOY scroller elsewhere does not mask a dead-clipped drawer body", () => {
    // Clamped drawer with NO real body scroll, but an unrelated `max-h-48
    // overflow-y-auto` code block — exactly the McpDetailDrawer false-negative
    // codex flagged. hasDrawerScrollBody must NOT be satisfied by the decoy.
    const decoyed = `<DrawerContent className="max-h-[88vh] flex flex-col">{body}<pre className="max-h-48 overflow-y-auto">{log}</pre></DrawerContent>`;
    expect(hasDrawerScrollBody(decoyed)).toBe(false);
    const real = `<DrawerContent className="max-h-[88vh] flex flex-col"><div className="flex-1 min-h-0 overflow-y-auto">{body}</div></DrawerContent>`;
    expect(hasDrawerScrollBody(real)).toBe(true);
  });

  it("self-test: a COMMENT mentioning the class does not satisfy the gate", () => {
    // A pager surface whose real touch-action was deleted but whose COMMENT still
    // says `touch-pan-y` must still be flagged — the HomeLauncherSurface
    // false-negative codex flagged. stripComments (applied in read()) is what
    // makes this hold on the real file; here we prove the raw string form.
    const commentOnly = stripComments(
      [
        "const pager = useHorizontalPager({ page, pageCount: 2 });",
        "// touch-pan-y: reserve vertical panning for the browser",
        'return <div ref={pager.viewportRef} className="overflow-hidden"',
        "  onPointerDown={pager.handlers.onPointerDown} />;",
      ].join("\n"),
    );
    expect(hasUnpinnedPagerSwipe(commentOnly)).toBe(true);
  });

  it("self-test: the broken-swipe (unpinned touch-action) shape is detected", () => {
    const buggy = [
      "const pager = useHorizontalPager({ page, pageCount: 2 });",
      'return <div ref={pager.viewportRef} className="overflow-hidden"',
      "  onPointerDown={pager.handlers.onPointerDown}",
      "  onPointerMove={pager.handlers.onPointerMove} />;",
    ].join("\n");
    const fixed = buggy.replace(
      'className="overflow-hidden"',
      'className="overflow-hidden touch-pan-y" style={{ touchAction: "pan-y" }}',
    );
    expect(hasUnpinnedPagerSwipe(buggy)).toBe(true);
    expect(hasUnpinnedPagerSwipe(fixed)).toBe(false);
  });
});
