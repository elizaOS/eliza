// @vitest-environment jsdom
/**
 * Portable-stories smoke test for the primitive layer.
 *
 * Every `components/ui/*.stories.tsx` story is composed via Storybook's
 * `composeStories` and rendered in jsdom — asserting it mounts without throwing.
 * This complements the browser story gate (`test/story-gate/`) with a fast lane
 * that runs on every `test:client` CI pass, and it auto-covers new primitive
 * stories the moment they are added (no per-component test to write).
 *
 * Renders are deterministic: `vitest.setup.ts` pins `TZ=UTC` and the stories'
 * own args are static. Global decorators (TooltipProvider) are supplied here so
 * tooltip/hover-card stories mount cleanly without pulling the full preview.
 */
import { composeStories } from "@storybook/react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TooltipProvider } from "../tooltip";

// jsdom lacks the layout/observer/pointer APIs that recharts, embla, and Radix
// touch on mount. Polyfill the standard set so primitive stories render instead
// of throwing on a missing global.
beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const g = globalThis as unknown as Record<string, unknown>;
  g.ResizeObserver ??= RO;
  g.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
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
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
});

// Eagerly import every primitive story module. import.meta.glob is a Vite
// feature vitest supports; `eager` returns the evaluated modules.
const storyModules = import.meta.glob("../*.stories.tsx", { eager: true });

afterEach(cleanup);

const moduleEntries = Object.entries(storyModules);

it("discovers primitive story modules", () => {
  expect(moduleEntries.length).toBeGreaterThan(20);
});

for (const [path, mod] of moduleEntries) {
  const name = path.replace("../", "").replace(".stories.tsx", "");
  // composeStories returns one component per named export, with meta-level
  // decorators/args already applied.
  let composed: Record<string, React.ComponentType>;
  try {
    composed = composeStories(mod as Parameters<typeof composeStories>[0]);
  } catch (err) {
    // A module that cannot be composed (no default meta) is surfaced loudly.
    describe(name, () => {
      it("composes", () => {
        throw err;
      });
    });
    continue;
  }

  const stories = Object.entries(composed);
  if (!stories.length) continue;

  describe(`primitive story: ${name}`, () => {
    for (const [storyName, Story] of stories) {
      it(`${storyName} renders without throwing`, () => {
        const { container } = render(
          <TooltipProvider>
            <Story />
          </TooltipProvider>,
        );
        expect(container.firstChild ?? container).toBeTruthy();
      });
    }
  });
}
