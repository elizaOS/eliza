// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredStewardToken,
  hasStewardAuthedCookie,
  STEWARD_SESSION_TRANSITION_EVENT,
  type StewardSessionTransition,
  stewardAuthedCookieName,
  writeStoredStewardToken,
} from "./index";

function stubDocumentCookie(cookie: string): void {
  vi.stubGlobal("document", { cookie });
}

describe("steward session marker cookie", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps production and unset environments on the historical marker", () => {
    expect(stewardAuthedCookieName()).toBe("steward-authed");
    expect(stewardAuthedCookieName("production")).toBe("steward-authed");
  });

  it("suffixes non-production marker cookies by environment", () => {
    expect(stewardAuthedCookieName("staging")).toBe("steward-authed-staging");
    expect(stewardAuthedCookieName("dev")).toBe("steward-authed-dev");
  });

  it("does not let a staging page trust the production marker", () => {
    stubDocumentCookie("steward-authed=1");
    expect(hasStewardAuthedCookie("staging")).toBe(false);

    stubDocumentCookie("steward-authed-staging=1; steward-authed=1");
    expect(hasStewardAuthedCookie("staging")).toBe(true);
  });
});

describe("steward session transition authority", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("publishes ordered non-secret present and cleared transitions", () => {
    const transitions: StewardSessionTransition[] = [];
    const listener = (event: Event) => {
      transitions.push((event as CustomEvent<StewardSessionTransition>).detail);
    };
    window.addEventListener(STEWARD_SESSION_TRANSITION_EVENT, listener);

    writeStoredStewardToken("never-publish-this-token");
    clearStoredStewardToken();

    window.removeEventListener(STEWARD_SESSION_TRANSITION_EVENT, listener);
    expect(transitions.map(({ state }) => state)).toEqual([
      "present",
      "cleared",
    ]);
    expect(transitions[1]?.sessionEpoch).toBeGreaterThan(
      transitions[0]?.sessionEpoch ?? 0,
    );
    expect(JSON.stringify(transitions)).not.toContain(
      "never-publish-this-token",
    );
  });

  it("publishes an explicit clear for a cookie-only session", () => {
    const transitions: StewardSessionTransition[] = [];
    const listener = (event: Event) => {
      transitions.push((event as CustomEvent<StewardSessionTransition>).detail);
    };
    window.addEventListener(STEWARD_SESSION_TRANSITION_EVENT, listener);

    expect(window.localStorage.getItem("steward_session_token")).toBeNull();
    clearStoredStewardToken();

    window.removeEventListener(STEWARD_SESSION_TRANSITION_EVENT, listener);
    expect(transitions.at(-1)?.state).toBe("cleared");
  });
});
