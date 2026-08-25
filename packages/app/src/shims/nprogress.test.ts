/**
 * Unit tests for the browser `nprogress` shim. The suite drives the real
 * singleton (named exports and default) and records clamp/set/start/done/inc
 * trickle behaviour, idle vs in-flight status, overflow past 1, missing-element
 * removal, and DOM render reuse as implemented.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import nprogress, {
  configure,
  done,
  getPositioningCSS,
  inc,
  isRendered,
  isStarted,
  remove,
  render,
  set,
  start,
  trickle,
} from "./nprogress.js";

const DEFAULT_SETTINGS = { ...nprogress.settings };

function resetShim(): void {
  nprogress.configure({ ...DEFAULT_SETTINGS });
  nprogress.set(1);
  nprogress.remove();
}

beforeEach(() => {
  resetShim();
});

afterEach(() => {
  resetShim();
});

describe("nprogress exports", () => {
  it("uses the same singleton for default and named function exports", () => {
    expect(configure).toBe(nprogress.configure);
    expect(set).toBe(nprogress.set);
    expect(start).toBe(nprogress.start);
    expect(done).toBe(nprogress.done);
    expect(inc).toBe(nprogress.inc);
    expect(trickle).toBe(nprogress.trickle);
    expect(isStarted).toBe(nprogress.isStarted);
    expect(render).toBe(nprogress.render);
    expect(remove).toBe(nprogress.remove);
    expect(isRendered).toBe(nprogress.isRendered);
    expect(getPositioningCSS).toBe(nprogress.getPositioningCSS);
  });

  it("exposes version 0.2.0 and the default settings snapshot", () => {
    expect(nprogress.version).toBe("0.2.0");
    expect(nprogress.status).toBeNull();
    expect(nprogress.settings).toEqual({
      minimum: 0.08,
      easing: "ease",
      positionUsing: "",
      speed: 200,
      trickle: true,
      trickleRate: 0.02,
      trickleSpeed: 800,
      showSpinner: true,
      barSelector: '[role="bar"]',
      spinnerSelector: '[role="spinner"]',
      parent: "body",
      template:
        '<div class="bar" role="bar"><div class="peg"></div></div><div class="spinner" role="spinner"><div class="spinner-icon"></div></div>',
    });
  });
});

describe("nprogress idle queue", () => {
  it("starts idle: status null, not started, not rendered", () => {
    expect(nprogress.status).toBeNull();
    expect(isStarted()).toBe(false);
    expect(isRendered()).toBe(false);
    expect(document.getElementById("nprogress")).toBeNull();
  });

  it("remove of a missing element is a no-op", () => {
    expect(document.getElementById("nprogress")).toBeNull();
    expect(() => remove()).not.toThrow();
    expect(isRendered()).toBe(false);
    expect(nprogress.status).toBeNull();
  });

  it("done without force is a no-op while idle", () => {
    expect(done()).toBe(nprogress);
    expect(done(false)).toBe(nprogress);
    expect(nprogress.status).toBeNull();
    expect(isStarted()).toBe(false);
    expect(isRendered()).toBe(false);
  });
});

describe("nprogress configure", () => {
  it("returns the singleton and is a no-op with no options", () => {
    expect(configure()).toBe(nprogress);
    expect(nprogress.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("assigns provided keys in place and leaves the rest", () => {
    const settings = nprogress.settings;
    expect(configure({ minimum: 0.3, easing: "linear" })).toBe(nprogress);
    expect(nprogress.settings).toBe(settings);
    expect(nprogress.settings.minimum).toBe(0.3);
    expect(nprogress.settings.easing).toBe("linear");
    expect(nprogress.settings.speed).toBe(DEFAULT_SETTINGS.speed);
  });
});

describe("nprogress set clamp and overflow", () => {
  it("stores a mid-range value, starts, and renders a bar", () => {
    expect(set(0.5)).toBe(nprogress);
    expect(nprogress.status).toBe(0.5);
    expect(isStarted()).toBe(true);
    expect(isRendered()).toBe(true);
    const node = document.getElementById("nprogress");
    expect(node).not.toBeNull();
    expect(node?.getAttribute("aria-hidden")).toBe("true");
    expect(node?.querySelector(".bar")).not.toBeNull();
  });

  it("clamps finite values below 0 to 0 and treats 0 as started", () => {
    set(-0.5);
    expect(nprogress.status).toBe(0);
    expect(isStarted()).toBe(true);
    expect(isRendered()).toBe(true);
  });

  it("resets status to null when the value is 1 or greater", () => {
    set(0.4);
    expect(isRendered()).toBe(true);
    set(1);
    expect(nprogress.status).toBeNull();
    expect(isStarted()).toBe(false);
    expect(isRendered()).toBe(false);
    set(0.4);
    set(1.5);
    expect(nprogress.status).toBeNull();
    expect(isRendered()).toBe(false);
  });

  it("clamps NaN and -Infinity to 0; Infinity completes and clears", () => {
    set(Number.NaN);
    expect(nprogress.status).toBe(0);
    expect(isStarted()).toBe(true);
    set(Number.NEGATIVE_INFINITY);
    expect(nprogress.status).toBe(0);
    set(Number.POSITIVE_INFINITY);
    expect(nprogress.status).toBeNull();
    expect(isStarted()).toBe(false);
    expect(isRendered()).toBe(false);
  });
});

describe("nprogress start", () => {
  it("sets the configured minimum from idle and chains the singleton", () => {
    expect(start()).toBe(nprogress);
    expect(nprogress.status).toBe(0.08);
    expect(isStarted()).toBe(true);
    expect(isRendered()).toBe(true);
  });

  it("is a no-op when already started, including at status 0", () => {
    set(0.4);
    expect(start()).toBe(nprogress);
    expect(nprogress.status).toBe(0.4);
    set(0);
    start();
    expect(nprogress.status).toBe(0);
  });

  it("uses a configured minimum, including 0 and a completing 1", () => {
    configure({ minimum: 0.25 });
    start();
    expect(nprogress.status).toBe(0.25);
    resetShim();
    configure({ minimum: 0 });
    start();
    expect(nprogress.status).toBe(0);
    expect(isStarted()).toBe(true);
    resetShim();
    configure({ minimum: 1 });
    start();
    expect(nprogress.status).toBeNull();
    expect(isStarted()).toBe(false);
    expect(isRendered()).toBe(false);
  });
});

describe("nprogress done", () => {
  it("completes an in-flight bar even without force", () => {
    set(0.4);
    expect(done()).toBe(nprogress);
    expect(nprogress.status).toBeNull();
    expect(isStarted()).toBe(false);
    expect(isRendered()).toBe(false);
  });

  it("force-done from idle still ends idle and unrendered", () => {
    expect(done(true)).toBe(nprogress);
    expect(nprogress.status).toBeNull();
    expect(isStarted()).toBe(false);
    expect(isRendered()).toBe(false);
  });
});

describe("nprogress inc bands, amount, and overflow", () => {
  it("starts from idle and ignores the amount while status is null", () => {
    expect(inc(0.5)).toBe(nprogress);
    expect(nprogress.status).toBe(0.08);
  });

  it("adds 0.1 below 0.2, including the default minimum", () => {
    start();
    expect(inc()).toBe(nprogress);
    expect(nprogress.status).toBe(0.08 + 0.1);
    set(0.19);
    inc();
    expect(nprogress.status).toBe(0.19 + 0.1);
  });

  it("adds 0.04 from 0.2 inclusive up to 0.5 exclusive", () => {
    set(0.2);
    inc();
    expect(nprogress.status).toBe(0.2 + 0.04);
    set(0.49);
    inc();
    expect(nprogress.status).toBe(0.49 + 0.04);
  });

  it("adds 0.02 from 0.5 inclusive up to 0.8 exclusive", () => {
    set(0.5);
    inc();
    expect(nprogress.status).toBe(0.5 + 0.02);
    set(0.79);
    inc();
    expect(nprogress.status).toBe(0.79 + 0.02);
  });

  it("adds 0.005 from 0.8 inclusive", () => {
    set(0.8);
    inc();
    expect(nprogress.status).toBe(0.8 + 0.005);
    set(0.99);
    inc();
    expect(nprogress.status).toBe(0.99 + 0.005);
  });

  it("uses an explicit numeric amount, including 0 and negatives", () => {
    set(0.5);
    inc(0.01);
    expect(nprogress.status).toBe(0.51);
    set(0.5);
    inc(0);
    expect(nprogress.status).toBe(0.5);
    set(0.5);
    inc(-0.1);
    expect(nprogress.status).toBe(0.4);
  });

  it("NaN amount clamps to 0; overflow past 1 clears the bar", () => {
    set(0.5);
    inc(Number.NaN);
    expect(nprogress.status).toBe(0);
    set(0.9);
    inc(0.2);
    expect(nprogress.status).toBeNull();
    expect(isRendered()).toBe(false);
    set(0.996);
    inc();
    expect(nprogress.status).toBeNull();
  });

  it("inc at status 0 uses the <0.2 band rather than start()", () => {
    set(0);
    inc();
    expect(nprogress.status).toBe(0.1);
  });
});

describe("nprogress trickle", () => {
  it("is inc with no amount, including the idle start path", () => {
    expect(trickle()).toBe(nprogress);
    expect(nprogress.status).toBe(0.08);
    expect(trickle()).toBe(nprogress);
    expect(nprogress.status).toBe(0.08 + 0.1);
  });

  it("does not read trickleRate for the delta", () => {
    configure({ trickleRate: 0.5 });
    set(0.5);
    trickle();
    expect(nprogress.status).toBe(0.5 + 0.02);
  });
});

describe("nprogress render and remove", () => {
  it("creates #nprogress once and reuses a pre-existing node", () => {
    const first = render();
    expect(first).toBeInstanceOf(HTMLElement);
    expect(first?.id).toBe("nprogress");
    expect(render()).toBe(first);
    first?.remove();
    const preexisting = document.createElement("div");
    preexisting.id = "nprogress";
    document.body.appendChild(preexisting);
    expect(render()).toBe(preexisting);
    expect(preexisting.querySelector(".bar")).toBeNull();
  });

  it("appends to documentElement when body is missing", () => {
    const body = document.body;
    body.remove();
    expect(document.body).toBeNull();
    const node = render();
    expect(node?.parentElement).toBe(document.documentElement);
    node?.remove();
    document.documentElement.appendChild(body);
  });

  it("getPositioningCSS is translate3d even when positionUsing is set", () => {
    expect(getPositioningCSS()).toBe("translate3d");
    configure({ positionUsing: "translate" });
    expect(getPositioningCSS()).toBe("translate3d");
  });
});

describe("nprogress without document", () => {
  function withUndefinedDocument<T>(fn: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      get() {
        return undefined;
      },
    });
    try {
      return fn();
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "document", descriptor);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }
  }

  it("render returns null, remove is a no-op, isRendered is false", () => {
    withUndefinedDocument(() => {
      expect(render()).toBeNull();
      expect(() => remove()).not.toThrow();
      expect(isRendered()).toBe(false);
    });
  });
});
