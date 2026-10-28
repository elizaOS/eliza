// @vitest-environment jsdom
/**
 * Focus follows the screen: when a screen change, HOME, an inline modal
 * surface or a rotation drops focus, it lands on the name of the screen in
 * front; focus that is somewhere real is never moved. jsdom has no layout, so
 * every connected element reports one client rectangle; retired content is
 * still judged by inert, hidden and aria-hidden, as in a browser.
 */
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createScreenFocus,
  firstNamedExposed,
  focusScreenElement,
  isExposed,
  isFocusDropped,
  SCREEN_FOCUS_ATTRIBUTE,
  type ScreenFocus,
} from "../screen-focus";
import { useScreenFocus } from "../use-screen-focus";

const originalRects = Element.prototype.getClientRects;
beforeEach(() => {
  Element.prototype.getClientRects = function (this: Element) {
    const rects = this.isConnected
      ? [{ x: 0, y: 0, width: 10, height: 10 }]
      : [];
    return rects as unknown as DOMRectList;
  };
});
let controller: ScreenFocus | null = null;
afterEach(() => {
  controller?.dispose();
  controller = null;
  cleanup();
  document.body.replaceChildren();
  Element.prototype.getClientRects = originalRects;
});

/** Waits for the given number of animation frames. */
async function frames(count = 4) {
  for (let index = 0; index < count; index += 1)
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
}

/** A Home region, one app with a title row, and a composer outside both. */
function phone() {
  document.body.innerHTML = `
    <section data-layer="home" aria-label="Home"><button>Settings</button><button>Files</button></section>
    <section data-layer="app" aria-label="Settings" inert aria-hidden="true" hidden>
      <header><button aria-label="Back to apps">Back</button><h1 data-title>Settings</h1></header>
      <button>Display</button>
    </section>
    <div role="group" aria-label="Assistant controls"><textarea aria-label="Ask"></textarea></div>`;
  const home = document.querySelector<HTMLElement>('[data-layer="home"]')!;
  const app = document.querySelector<HTMLElement>('[data-layer="app"]')!;
  const retire = (element: HTMLElement, retired: boolean) => {
    element.toggleAttribute("inert", retired);
    element.toggleAttribute("hidden", retired);
    if (retired) element.setAttribute("aria-hidden", "true");
    else element.removeAttribute("aria-hidden");
  };
  let current: "home" | "app" = "home";
  return {
    home,
    app,
    /** Shows a screen as a shell does: the old layer retires, the new one shows. */
    show(next: "home" | "app") {
      current = next;
      retire(home, next !== "home");
      retire(app, next === "home");
    },
    screen: (doc: Document) =>
      current === "home"
        ? isExposed(home)
          ? home
          : null
        : firstNamedExposed(doc, "[data-title]"),
    button: (name: string) =>
      Array.from(document.querySelectorAll("button")).find(
        (element) => element.textContent === name,
      ) as HTMLButtonElement,
  };
}

describe("exposure and dropped focus", () => {
  it("treats the body, detached elements and retired content as dropped focus", () => {
    const shell = phone();
    expect(isFocusDropped()).toBe(true);
    shell.button("Settings").focus();
    expect(isFocusDropped()).toBe(false);
    shell.show("app");
    expect(isFocusDropped()).toBe(true);
    expect(isExposed(shell.home)).toBe(false);
    expect(isExposed(shell.app)).toBe(true);
    shell.button("Display").focus();
    shell.button("Display").remove();
    expect(isFocusDropped()).toBe(true);
  });

  it("names a screen only by an exposed element with a name", () => {
    phone();
    expect(firstNamedExposed(document, "[data-title]")).toBeNull();
    const title = document.querySelector<HTMLElement>("[data-title]")!;
    title.closest("section")!.removeAttribute("hidden");
    title.closest("section")!.removeAttribute("inert");
    title.closest("section")!.removeAttribute("aria-hidden");
    expect(firstNamedExposed(document, "[data-title]")).toBe(title);
    title.textContent = " ";
    expect(firstNamedExposed(document, "[data-title]")).toBeNull();
  });

  it("focuses a screen name as a name, never as a tab stop", () => {
    const shell = phone();
    expect(focusScreenElement(shell.home)).toBe(true);
    expect(shell.home.getAttribute("tabindex")).toBe("-1");
    expect(shell.home.hasAttribute(SCREEN_FOCUS_ATTRIBUTE)).toBe(true);
    // An element with its own tab index keeps it.
    const button = shell.button("Files");
    expect(focusScreenElement(button)).toBe(true);
    expect(button.hasAttribute("tabindex")).toBe(false);
  });
});

describe("createScreenFocus", () => {
  it("moves dropped focus to the new screen's title, then to Home after HOME", async () => {
    const shell = phone();
    controller = createScreenFocus({ screen: shell.screen });
    shell.button("Settings").focus();
    shell.show("app");
    controller.screenChanged();
    await frames();
    const title = document.querySelector("[data-title]");
    expect(document.activeElement).toBe(title);
    expect(title?.getAttribute("tabindex")).toBe("-1");
    // HOME: the app retires with focus inside it.
    shell.button("Display").focus();
    shell.show("home");
    controller.screenChanged();
    await frames();
    expect(document.activeElement).toBe(shell.home);
  });

  it("waits for a screen that renders its title a few frames late", async () => {
    const shell = phone();
    const title = document.querySelector<HTMLElement>("[data-title]")!;
    title.remove();
    controller = createScreenFocus({ screen: shell.screen });
    shell.button("Settings").focus();
    shell.show("app");
    controller.screenChanged();
    await frames(3);
    // Still dropped (jsdom leaves it on the retired tile): nothing is named yet.
    expect(isFocusDropped()).toBe(true);
    shell.app.querySelector("header")!.append(title);
    await frames(3);
    expect(document.activeElement).toBe(title);
  });

  it("leaves focus that is somewhere real, and surfaces that manage their own focus", async () => {
    const shell = phone();
    controller = createScreenFocus({
      screen: shell.screen,
      selfFocused: '[aria-label="Voice conversation"]',
    });
    // Typing in the composer across a screen change.
    const composer = document.querySelector("textarea")!;
    composer.focus();
    shell.show("app");
    controller.screenChanged();
    await frames();
    expect(document.activeElement).toBe(composer);
    // An open native dialog owns focus.
    composer.blur();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    shell.show("home");
    controller.screenChanged();
    await frames();
    expect(document.activeElement).toBe(document.body);
    expect(controller.target()).toBeNull();
    dialog.remove();
    // So does a surface the host lists.
    const voice = document.createElement("div");
    voice.setAttribute("aria-label", "Voice conversation");
    document.body.append(voice);
    shell.show("app");
    controller.screenChanged();
    await frames();
    expect(document.activeElement).toBe(document.body);
    voice.remove();
    expect(controller.focusNow()).toBe(true);
    expect(document.activeElement).toBe(document.querySelector("[data-title]"));
  });

  it("judges nothing before the host shows its first screen", async () => {
    const shell = phone();
    let ready = false;
    controller = createScreenFocus({
      screen: shell.screen,
      ready: () => ready,
    });
    controller.screenChanged();
    await frames();
    expect(document.activeElement).toBe(document.body);
    expect(controller.focusNow()).toBe(false);
    ready = true;
    expect(controller.focusNow()).toBe(true);
    expect(document.activeElement).toBe(shell.home);
  });

  it("gives an inline modal surface that opens over dropped focus the focus, by its name", async () => {
    const shell = phone();
    // A surface open before this starts belongs to startup.
    const startup = document.createElement("div");
    startup.setAttribute("role", "dialog");
    startup.setAttribute("aria-modal", "true");
    startup.setAttribute("aria-label", "Welcome");
    startup.setAttribute("hidden", "");
    document.body.append(startup);
    controller = createScreenFocus({ screen: shell.screen });
    shell.button("Settings").focus();
    // All apps retires Home's tiles behind its own inline modal surface.
    shell.home.setAttribute("inert", "");
    shell.home.setAttribute("aria-hidden", "true");
    const drawer = document.createElement("div");
    drawer.innerHTML =
      '<input type="search" aria-label="Search apps"><button>Open Clock</button>';
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-label", "All apps");
    document.body.append(drawer);
    await frames();
    expect(document.activeElement).toBe(drawer);
    // Named by its label, never by typing into it: the search field stays unfocused.
    expect(document.activeElement).not.toBe(drawer.querySelector("input"));
    // HOME closes it with focus inside.
    shell.button("Open Clock").focus();
    drawer.remove();
    shell.home.removeAttribute("inert");
    shell.home.removeAttribute("aria-hidden");
    controller.screenChanged();
    await frames();
    expect(document.activeElement).toBe(shell.home);
  });

  it("returns focus a rotation took away, and leaves a blur the person made", async () => {
    const shell = phone();
    controller = createScreenFocus({ screen: shell.screen });
    // A page that never had focus gets none from a resize.
    window.dispatchEvent(new Event("resize"));
    await frames();
    expect(document.activeElement).toBe(document.body);
    shell.show("app");
    const display = shell.button("Display");
    display.focus();
    // The person moves focus away themselves; the control is still there.
    display.blur();
    window.dispatchEvent(new Event("resize"));
    await frames(16);
    expect(document.activeElement).toBe(document.body);
    // The landscape layout replaces the row that held focus.
    display.focus();
    const rebuilt = document.createElement("button");
    rebuilt.textContent = "Display";
    display.replaceWith(rebuilt);
    window.dispatchEvent(new Event("resize"));
    await frames();
    expect(document.activeElement).toBe(document.querySelector("[data-title]"));
  });

  it("styles programmatic focus for keyboard users only, and cleans up on dispose", async () => {
    const shell = phone();
    controller = createScreenFocus({ screen: shell.screen, focusRing: "blue" });
    const style = document.querySelector("style[data-screen-focus-style]");
    expect(style?.textContent).toContain(
      `[${SCREEN_FOCUS_ATTRIBUTE}]:focus-visible{outline:2px solid blue`,
    );
    controller.dispose();
    expect(document.querySelector("style[data-screen-focus-style]")).toBeNull();
    shell.button("Settings").focus();
    shell.show("app");
    controller.screenChanged();
    await frames();
    // A disposed controller moves nothing: focus stays dropped on the retired tile.
    expect(document.activeElement).toBe(shell.button("Settings"));
    expect(isFocusDropped()).toBe(true);
    controller = createScreenFocus({ screen: shell.screen, focusRing: false });
    expect(document.querySelector("style[data-screen-focus-style]")).toBeNull();
  });
});

describe("useScreenFocus", () => {
  function Shell() {
    const [screen, setScreen] = useState<"home" | "settings">("home");
    useScreenFocus(screen, {
      screen: (doc) =>
        firstNamedExposed(doc, screen === "home" ? "[data-home]" : "h1"),
    });
    return screen === "home" ? (
      <section data-home="" aria-label="Home">
        <button type="button" onClick={() => setScreen("settings")}>
          Settings
        </button>
      </section>
    ) : (
      <section aria-label="Settings">
        <h1>Settings</h1>
        <button type="button" onClick={() => setScreen("home")}>
          Back to apps
        </button>
      </section>
    );
  }

  it("moves focus a screen change dropped to the new screen's name, and leaves the first screen alone", async () => {
    const view = render(<Shell />);
    await act(() => frames());
    expect(document.activeElement).toBe(document.body);
    const settings = view.getByRole("button", { name: "Settings" });
    settings.focus();
    await act(async () => {
      settings.click();
    });
    await act(() => frames());
    expect(document.activeElement).toBe(
      view.getByRole("heading", { name: "Settings" }),
    );
    const back = view.getByRole("button", { name: "Back to apps" });
    back.focus();
    await act(async () => {
      back.click();
    });
    await act(() => frames());
    expect(document.activeElement).toBe(
      view.getByRole("region", { name: "Home" }),
    );
  });
});
