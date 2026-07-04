// @vitest-environment jsdom

/**
 * Covers the home-widget dismissal/sunset store: seen counts, acted/dismissed
 * flags, and `isHomeWidgetSunset` policy resolution. Pure logic over the
 * in-memory store (localStorage-backed at runtime; reset between cases).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetHomeDismissalsForTests,
  dismissHomeWidget,
  isHomeWidgetSunset,
  markHomeWidgetActed,
  recordHomeWidgetSeen,
} from "./home-dismissal-store";

const KEY = "welcome/welcome.ftu";

afterEach(() => __resetHomeDismissalsForTests());

describe("isHomeWidgetSunset", () => {
  it("never sunsets a widget with no policy", () => {
    markHomeWidgetActed(KEY);
    dismissHomeWidget(KEY);
    expect(
      isHomeWidgetSunset(KEY, undefined, {
        [KEY]: { seen: 9, acted: true, dismissed: true },
      }),
    ).toBe(false);
  });

  it("retires a dismissible widget once dismissed", () => {
    dismissHomeWidget(KEY);
    const sunset = { dismissible: true };
    expect(
      isHomeWidgetSunset(KEY, sunset, {
        [KEY]: { seen: 0, acted: false, dismissed: true },
      }),
    ).toBe(true);
    expect(isHomeWidgetSunset(KEY, sunset, {})).toBe(false);
  });

  it("retires an afterAction widget once acted on", () => {
    const sunset = { afterAction: true };
    expect(
      isHomeWidgetSunset(KEY, sunset, {
        [KEY]: { seen: 0, acted: true, dismissed: false },
      }),
    ).toBe(true);
    expect(
      isHomeWidgetSunset(KEY, sunset, {
        [KEY]: { seen: 0, acted: false, dismissed: false },
      }),
    ).toBe(false);
  });

  it("retires an afterSeen widget only AFTER it has been seen in more than N sessions", () => {
    const sunset = { afterSeen: 1 };
    // seen once → still shown this session
    expect(
      isHomeWidgetSunset(KEY, sunset, {
        [KEY]: { seen: 1, acted: false, dismissed: false },
      }),
    ).toBe(false);
    // seen in a second session → retired
    expect(
      isHomeWidgetSunset(KEY, sunset, {
        [KEY]: { seen: 2, acted: false, dismissed: false },
      }),
    ).toBe(true);
  });
});

describe("store mutations + persistence", () => {
  it("counts a session-view only once per session", () => {
    recordHomeWidgetSeen(KEY);
    recordHomeWidgetSeen(KEY);
    recordHomeWidgetSeen(KEY);
    const raw = JSON.parse(
      localStorage.getItem("eliza:home-dismissed:v1") ?? "{}",
    );
    expect(raw[KEY].seen).toBe(1);
  });

  it("persists acted + dismissed to localStorage", () => {
    markHomeWidgetActed(KEY);
    dismissHomeWidget(KEY);
    const raw = JSON.parse(
      localStorage.getItem("eliza:home-dismissed:v1") ?? "{}",
    );
    expect(raw[KEY]).toMatchObject({ acted: true, dismissed: true });
  });

  it("survives a corrupt persisted value without throwing", () => {
    localStorage.setItem("eliza:home-dismissed:v1", "{not json");
    // A fresh read happens at module load; the predicate must still be callable.
    expect(isHomeWidgetSunset(KEY, { dismissible: true }, {})).toBe(false);
  });
});
