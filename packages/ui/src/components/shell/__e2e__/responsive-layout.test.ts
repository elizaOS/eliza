// @vitest-environment jsdom
/**
 * Responsive layout decisions and the dock footprint publisher. jsdom has no
 * layout, so element offsets are assigned explicitly; the decisions and the
 * publisher's observers are the shipped code.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  installDockClearance,
  measureDockClearance,
  visibleDocks,
} from "../dock-clearance";
import {
  keyboardFreeHeight,
  raisesSoftKeyboard,
  sameSurfaceLayout,
  surfaceLayout,
} from "../responsive-layout";

describe("keyboardFreeHeight", () => {
  it("keeps a typing portrait window portrait", () => {
    const free = keyboardFreeHeight();
    expect(free(412, 915, false)).toBe(915);
    // Typing: the window is now wider than tall, but its width did not change.
    expect(free(412, 380, true)).toBe(915);
    // The keyboard closes or the field loses focus: the height is measured again.
    expect(free(412, 380, false)).toBe(380);
  });

  it("honours a rotation even while a field has focus", () => {
    const turned = keyboardFreeHeight();
    turned(412, 915, true);
    // Landscape now: the previous width bounds the keyboard-free height, which
    // is still shorter than the new width.
    expect(turned(915, 300, true)).toBe(412);
    // Turning back with the keyboard still up: the sides were swapped, so the
    // previous width stands in for the keyboard-free height.
    expect(turned(412, 380, true)).toBe(915);
  });

  it("treats a small landscape phone turned to portrait with the keyboard up as portrait", () => {
    const small = keyboardFreeHeight();
    small(640, 360, false);
    expect(small(640, 150, true)).toBe(360);
    expect(small(360, 330, true)).toBe(640);
    expect(small(640, 150, true)).toBe(360);
    expect(small(360, 600, false)).toBe(600);
  });

  it("takes the measured height after a width change that is not a swap", () => {
    const resized = keyboardFreeHeight();
    resized(500, 900, false);
    expect(resized(700, 400, true)).toBe(400);
  });
});

describe("raisesSoftKeyboard", () => {
  it("accepts editable text entry only", () => {
    const make = (html: string) => {
      document.body.innerHTML = html;
      return document.body.firstElementChild;
    };
    expect(raisesSoftKeyboard(make("<textarea></textarea>"))).toBe(true);
    expect(raisesSoftKeyboard(make("<textarea readonly></textarea>"))).toBe(
      false,
    );
    expect(raisesSoftKeyboard(make('<input type="search">'))).toBe(true);
    expect(raisesSoftKeyboard(make('<input type="checkbox">'))).toBe(false);
    expect(raisesSoftKeyboard(make('<input type="text" readonly>'))).toBe(
      false,
    );
    const editable = make("<div></div>") as HTMLElement;
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(raisesSoftKeyboard(editable)).toBe(true);
    expect(raisesSoftKeyboard(make("<button></button>"))).toBe(false);
    expect(raisesSoftKeyboard(null)).toBe(false);
  });
});

describe("surfaceLayout", () => {
  it("splits wide content and fits readable day columns", () => {
    expect(surfaceLayout(412, 1)).toEqual({
      split: false,
      calendarDays: 1,
      agenda: false,
    });
    expect(surfaceLayout(1280, 1)).toEqual({
      split: true,
      calendarDays: 5,
      agenda: false,
    });
    expect(surfaceLayout(1280, 1.25).calendarDays).toBe(4);
    expect(surfaceLayout(4000, 1).calendarDays).toBe(7);
  });

  it("returns to one pane with an agenda at large text", () => {
    expect(surfaceLayout(1280, 1.5)).toEqual({
      split: false,
      calendarDays: 1,
      agenda: true,
    });
    expect(surfaceLayout(1280, 2, { largeText: 2.5 }).agenda).toBe(false);
  });

  it("keeps the phone layout for a desktop preview, an unmeasured width or a bad scale", () => {
    expect(surfaceLayout(1280, 1, { desktop: true }).split).toBe(false);
    expect(surfaceLayout(Number.NaN, 1).calendarDays).toBe(1);
    expect(surfaceLayout(1280, Number.NaN).split).toBe(true);
    expect(surfaceLayout(900, 1, { splitWidth: 800 }).split).toBe(true);
  });

  it("compares the rendered choices only", () => {
    expect(
      sameSurfaceLayout(surfaceLayout(412, 1), surfaceLayout(500, 1)),
    ).toBe(true);
    expect(
      sameSurfaceLayout(surfaceLayout(412, 1), surfaceLayout(1280, 1)),
    ).toBe(false);
  });
});

/** A screen 800px tall holding a dock whose bar is its last 60px row. */
function dockedScreen(dockTop = 600, barTop = 140) {
  document.body.innerHTML =
    "<main data-test-screen><section data-test-dock><div data-test-bar></div></section></main>";
  const screen = document.querySelector<HTMLElement>("[data-test-screen]");
  const dock = document.querySelector<HTMLElement>("[data-test-dock]");
  const bar = document.querySelector<HTMLElement>("[data-test-bar]");
  if (!screen || !dock || !bar) throw new Error("fixture");
  const place = (
    element: HTMLElement,
    top: number,
    parent: HTMLElement | null,
  ) => {
    Object.defineProperty(element, "offsetTop", {
      configurable: true,
      get: () => top,
    });
    Object.defineProperty(element, "offsetParent", {
      configurable: true,
      get: () => parent,
    });
    Object.defineProperty(element, "getClientRects", {
      configurable: true,
      value: () => [{}],
    });
  };
  Object.defineProperty(screen, "clientHeight", { value: 800 });
  Object.defineProperty(screen, "offsetWidth", { value: 412 });
  place(dock, dockTop, screen);
  place(bar, barTop, dock);
  return { screen, dock, bar, move: (top: number) => place(dock, top, screen) };
}

describe("dock clearance", () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    document.body.innerHTML = "";
  });

  it("measures everything a dock covers and its resting bar", () => {
    const { screen, dock } = dockedScreen();
    expect(measureDockClearance(screen, [dock], "[data-test-bar]")).toEqual({
      clearance: 200,
      rest: 60,
    });
    expect(measureDockClearance(screen, [dock])).toEqual({
      clearance: 200,
      rest: 200,
    });
    expect(measureDockClearance(screen, [])).toBeNull();
  });

  it("skips docks retired behind inert or not rendered", () => {
    const { screen, dock } = dockedScreen();
    expect(visibleDocks(screen, "[data-test-dock]")).toEqual([dock]);
    screen.setAttribute("inert", "");
    expect(visibleDocks(screen, "[data-test-dock]")).toEqual([]);
    screen.removeAttribute("inert");
    Object.defineProperty(dock, "getClientRects", { value: () => [] });
    expect(visibleDocks(screen, "[data-test-dock]")).toEqual([]);
  });

  it("publishes the footprint, follows a dock change at once and cleans up", async () => {
    const { dock, move } = dockedScreen();
    const style = document.documentElement.style;
    uninstall = installDockClearance({
      screen: "[data-test-screen]",
      docks: "[data-test-dock]",
      bar: "[data-test-bar]",
      clearanceProperty: "--test-dock-clearance",
      restProperty: "--test-dock-rest",
    });
    expect(style.getPropertyValue("--test-dock-clearance")).toBe("200px");
    expect(style.getPropertyValue("--test-dock-rest")).toBe("60px");
    // A status row grows the dock: the change inside the dock is published in
    // the same observer delivery.
    move(520);
    dock.append(document.createElement("p"));
    await Promise.resolve();
    expect(style.getPropertyValue("--test-dock-clearance")).toBe("280px");
    // No dock on screen keeps the last footprint.
    document.querySelector("[data-test-screen]")?.setAttribute("inert", "");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(style.getPropertyValue("--test-dock-clearance")).toBe("280px");
    uninstall();
    uninstall = undefined;
    expect(style.getPropertyValue("--test-dock-clearance")).toBe("");
    expect(style.getPropertyValue("--test-dock-rest")).toBe("");
  });
});
