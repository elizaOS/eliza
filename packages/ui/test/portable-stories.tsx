/**
 * Shared harness for portable-stories smoke tests.
 *
 * Storybook stories are the canonical catalog of every component state. Rather
 * than hand-write a render test per component, each story directory gets a tiny
 * test file that globs its `*.stories.tsx`, composes them with Storybook's
 * `composeStories`, and renders each in jsdom — asserting it mounts without
 * throwing. This is the fast (jsdom) counterpart to the browser story gate and
 * auto-covers new stories the moment they are added.
 *
 * Per-directory test file:
 *   import { smokeStoryModules } from "../../../test/portable-stories";
 *   const mods = import.meta.glob("../*.stories.tsx", { eager: true });
 *   smokeStoryModules("primitive", mods);
 */
import { composeStories } from "@storybook/react";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType, ReactElement, ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { TooltipProvider } from "../src/components/ui/tooltip";

/** Polyfill the jsdom gaps that recharts / embla / Radix touch on mount. */
export function installJsdomUiPolyfills(): void {
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= Observer;
  g.IntersectionObserver ??= Observer;
  if (typeof window !== "undefined") {
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    })) as typeof window.matchMedia;
    window.scrollTo ??= () => {};
  }
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => {};
  proto.scrollTo ??= () => {};
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
}

type StoryModules = Record<string, unknown>;

/**
 * Compose + render every story in `modules`. `label` names the group; `wrap`
 * lets a directory inject a required provider around each story.
 */
export function smokeStoryModules(
  label: string,
  modules: StoryModules,
  options: {
    wrap?: (node: ReactNode) => ReactNode;
    minModules?: number;
    /**
     * `"<Module>/<Story>"` keys to render as `it.skip` — for stories that need
     * the full app runtime (live AppProvider data: plugins, appRuns, transcript
     * sinks) that jsdom composition can't supply. These are covered by the
     * browser story gate's `needs-runtime` path and the live `audit:app`.
     */
    skip?: string[];
  } = {},
): void {
  const wrap =
    options.wrap ??
    ((node: ReactNode) => <TooltipProvider>{node}</TooltipProvider>);
  const skip = new Set(options.skip ?? []);

  beforeAll(() => {
    installJsdomUiPolyfills();
    // This smoke is offline (no backend behind jsdom), but components still
    // fire real on-mount fetches whose socket errors settle on the network's
    // schedule — on a loaded CI worker that can be AFTER vitest tore down the
    // file's jsdom environment, where the late setState makes react-dom read
    // the deleted `window` and the file fails with an unhandled
    // "window is not defined" rejection. Keep every request forever-pending
    // instead: components render their designed loading state and no
    // settlement can ever fire after unmount/teardown.
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
  afterEach(cleanup);

  const entries = Object.entries(modules);

  it(`discovers ${label} story modules`, () => {
    expect(entries.length).toBeGreaterThanOrEqual(options.minModules ?? 1);
  });

  for (const [path, mod] of entries) {
    const name = path.split("/").pop()?.replace(".stories.tsx", "") ?? path;
    let composed: Record<string, ComponentType>;
    try {
      composed = composeStories(mod as Parameters<typeof composeStories>[0]);
    } catch (err) {
      describe(`${label}: ${name}`, () => {
        it("composes", () => {
          throw err;
        });
      });
      continue;
    }
    const stories = Object.entries(composed);
    if (!stories.length) continue;
    describe(`${label}: ${name}`, () => {
      for (const [storyName, Story] of stories) {
        const testFn = skip.has(`${name}/${storyName}`) ? it.skip : it;
        testFn(`${storyName} renders without throwing`, async () => {
          // The coverage here IS the absence of a throw: composing the story
          // (above) and mounting it must not error. There is intentionally no
          // "produced DOM" assertion — null/empty renders are valid in this jsdom
          // lane. Many stories are empty-by-design (Closed/Disabled/Empty states)
          // or render nothing without the full app runtime (browser-status,
          // ShortcutsOverlay/Open, …). Blank-render detection that needs that
          // runtime lives in the browser story gate (its needs-runtime path) and
          // the live audit:app — not this fast offline smoke.
          const { container } = render(wrap(<Story />) as ReactElement);
          // If the story defines an interaction (`play`), run it — so authoring a
          // play function automatically gets it exercised in this lane, with no
          // per-component test to wire up.
          const play = (
            Story as {
              play?: (ctx: {
                canvasElement: HTMLElement;
              }) => void | Promise<void>;
            }
          ).play;
          if (typeof play === "function") {
            await play({ canvasElement: container });
          }
        });
      }
    });
  }
}
