/** Verifies the Switch-runtime reload helper through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Direct unit coverage for `./reload-into-first-run-runtime.ts` — the helper
 * behind Settings > Runtime "Switch runtime" and the mobile deep-link entry.
 *
 * Storage assertions run against the real jsdom localStorage: the module
 * clears two persisted keys through `shellLocalStorage`, and those removals
 * are observable state. Only the final `location.href` assignment is recorded
 * via a stubbed `window`, because jsdom cannot perform a navigation and offers
 * no other observation point; every stub still hands the module the REAL
 * localStorage object. `readFirstRunRuntimeTarget` is exercised as a pure
 * parser over explicit inputs plus the live `window.location.search` default.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_RUNTIME_MODE_STORAGE_KEY } from "./mobile-runtime-mode";
import {
  __TEST_ONLY__,
  FIRST_RUN_QUERY_NAME,
  FIRST_RUN_QUERY_VALUE,
  FIRST_RUN_TARGET_QUERY_NAME,
  readFirstRunRuntimeTarget,
  reloadIntoFirstRunRuntime,
} from "./reload-into-first-run-runtime";

const ACTIVE_SERVER_STORAGE_KEY = __TEST_ONLY__.ACTIVE_SERVER_STORAGE_KEY;

type LocationStub = { href: string };

function firstRunSearch(target?: string): string {
  const params = new URLSearchParams();
  params.set(FIRST_RUN_QUERY_NAME, FIRST_RUN_QUERY_VALUE);
  if (target !== undefined) {
    params.set(FIRST_RUN_TARGET_QUERY_NAME, target);
  }
  return `?${params.toString()}`;
}

function stubWindowWith(location: LocationStub): void {
  vi.stubGlobal("window", { location, localStorage: window.localStorage });
}

describe("first-run query contract", () => {
  it("pins the query names/values deep-link-handler and hosts share", () => {
    expect(FIRST_RUN_QUERY_NAME).toBe("runtime");
    expect(FIRST_RUN_QUERY_VALUE).toBe("first-run");
    expect(FIRST_RUN_TARGET_QUERY_NAME).toBe("runtimeTarget");
  });

  it("exposes the persisted keys it clears, mirroring their owners", () => {
    expect(__TEST_ONLY__.ACTIVE_SERVER_STORAGE_KEY).toBe(
      "elizaos:active-server",
    );
    expect(__TEST_ONLY__.MOBILE_RUNTIME_MODE_STORAGE_KEY).toBe(
      MOBILE_RUNTIME_MODE_STORAGE_KEY,
    );
    expect(__TEST_ONLY__.MOBILE_RUNTIME_MODE_STORAGE_KEY).toBe(
      "eliza:mobile-runtime-mode",
    );
  });
});

describe("readFirstRunRuntimeTarget", () => {
  it.each(["cloud", "local", "remote"] as const)(
    "parses a pinned %s target",
    (target) => {
      expect(
        readFirstRunRuntimeTarget(`?runtime=first-run&runtimeTarget=${target}`),
      ).toBe(target);
    },
  );

  it("returns null unless runtime is exactly first-run", () => {
    expect(readFirstRunRuntimeTarget("")).toBeNull();
    expect(readFirstRunRuntimeTarget("?")).toBeNull();
    expect(readFirstRunRuntimeTarget("?runtime=onboarding")).toBeNull();
    expect(readFirstRunRuntimeTarget("?runtime=first-runX")).toBeNull();
    expect(readFirstRunRuntimeTarget("?runtime=First-Run")).toBeNull();
  });

  it("falls back to local when the target is missing or invalid", () => {
    expect(readFirstRunRuntimeTarget("?runtime=first-run")).toBe("local");
    expect(readFirstRunRuntimeTarget("?runtime=first-run&runtimeTarget=")).toBe(
      "local",
    );
    expect(
      readFirstRunRuntimeTarget("?runtime=first-run&runtimeTarget=bogus"),
    ).toBe("local");
    expect(
      readFirstRunRuntimeTarget("?runtime=first-run&runtimeTarget=CLOUD"),
    ).toBe("local");
  });

  it("accepts a URLSearchParams instance directly", () => {
    const params = new URLSearchParams(
      "?runtime=first-run&runtimeTarget=remote",
    );
    expect(readFirstRunRuntimeTarget(params)).toBe("remote");
    expect(readFirstRunRuntimeTarget(new URLSearchParams())).toBeNull();
  });

  it("reads the live window.location.search when no argument is given", () => {
    window.history.replaceState(
      null,
      "",
      `http://localhost/${firstRunSearch("cloud")}`,
    );
    expect(readFirstRunRuntimeTarget()).toBe("cloud");

    window.history.replaceState(null, "", "http://localhost/settings");
    expect(readFirstRunRuntimeTarget()).toBeNull();
  });

  it("returns null from the SSR default when window is undefined", () => {
    vi.stubGlobal("window", undefined);
    try {
      expect(readFirstRunRuntimeTarget()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("reloadIntoFirstRunRuntime", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "http://localhost/");
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it.each(["cloud", "local", "remote"] as const)(
    "clears both persisted keys and forces first-run pinned to %s",
    (target) => {
      window.localStorage.setItem(ACTIVE_SERVER_STORAGE_KEY, "local:mobile");
      window.localStorage.setItem(
        MOBILE_RUNTIME_MODE_STORAGE_KEY,
        "remote-mac",
      );
      const location: LocationStub = {
        href: "http://localhost/settings/runtime",
      };
      stubWindowWith(location);

      reloadIntoFirstRunRuntime(target);

      // The switch wipes the active-server record AND the persisted mobile
      // runtime mode before reloading, so boot cannot restore the old runtime.
      expect(window.localStorage.getItem(ACTIVE_SERVER_STORAGE_KEY)).toBeNull();
      expect(
        window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY),
      ).toBeNull();
      expect(location.href).toBe(
        `http://localhost/settings/runtime${firstRunSearch(target)}`,
      );
    },
  );

  it("drops a stale runtimeTarget and keeps unrelated params when no target is passed", () => {
    const location: LocationStub = {
      href: "http://localhost/?runtime=first-run&runtimeTarget=cloud&tab=general",
    };
    stubWindowWith(location);

    reloadIntoFirstRunRuntime();

    expect(location.href).toBe(
      "http://localhost/?runtime=first-run&tab=general",
    );
  });

  it("overwrites a non-first-run runtime value in place", () => {
    const location: LocationStub = {
      href: "http://localhost/?runtime=onboarding&foo=1",
    };
    stubWindowWith(location);

    reloadIntoFirstRunRuntime("remote");

    expect(location.href).toBe(
      "http://localhost/?runtime=first-run&foo=1&runtimeTarget=remote",
    );
  });

  it("still navigates when removing the active-server record throws", () => {
    window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud");
    window.localStorage.setItem(ACTIVE_SERVER_STORAGE_KEY, "local:mobile");
    const realRemoveItem = window.localStorage.removeItem.bind(
      window.localStorage,
    );
    // Error injection on the real store: only the active-server key fails, so
    // the mode-key removal still exercises the genuine write path.
    vi.spyOn(window.localStorage, "removeItem").mockImplementation(
      (key: string) => {
        if (key === ACTIVE_SERVER_STORAGE_KEY) {
          throw new DOMException("denied", "SecurityError");
        }
        realRemoveItem(key);
      },
    );
    const location: LocationStub = { href: "http://localhost/" };
    stubWindowWith(location);

    expect(() => reloadIntoFirstRunRuntime("local")).not.toThrow();

    // The best-effort cleanup swallows the failure and the query navigation
    // still forces first-run — that navigation is the load-bearing effect.
    expect(window.localStorage.getItem(ACTIVE_SERVER_STORAGE_KEY)).toBe(
      "local:mobile",
    );
    expect(
      window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY),
    ).toBeNull();
    expect(location.href).toBe(`http://localhost/${firstRunSearch("local")}`);
  });

  it("does nothing — including no persistence writes — when window is undefined", () => {
    const storage = window.localStorage;
    storage.setItem(ACTIVE_SERVER_STORAGE_KEY, "survivor");
    storage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud");
    vi.stubGlobal("window", undefined);

    expect(() => reloadIntoFirstRunRuntime("cloud")).not.toThrow();

    vi.unstubAllGlobals();
    expect(storage.getItem(ACTIVE_SERVER_STORAGE_KEY)).toBe("survivor");
    expect(storage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe("cloud");
  });
});
