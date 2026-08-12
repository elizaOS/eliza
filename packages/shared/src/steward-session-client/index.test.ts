/** Tests the shared Steward browser-session contract with deterministic DOM state. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredStewardToken,
  hasStewardAuthedCookie,
  STEWARD_SESSION_CHANGE_EVENT,
  STEWARD_TOKEN_KEY,
  type StewardSessionChangeDetail,
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

describe("Steward session storage transitions", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("publishes ordered typed transitions after canonical writes and clears", () => {
    const transitions: StewardSessionChangeDetail[] = [];
    const listener = (event: Event) => {
      transitions.push(
        (event as CustomEvent<StewardSessionChangeDetail>).detail,
      );
    };
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);

    try {
      writeStoredStewardToken("steward-token");
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("steward-token");
      clearStoredStewardToken();
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    } finally {
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    }

    expect(transitions).toHaveLength(2);
    expect(transitions[0]?.state).toBe("present");
    expect(transitions[1]?.state).toBe("cleared");
    expect(transitions[1]?.sessionEpoch).toBeGreaterThan(
      transitions[0]?.sessionEpoch ?? 0,
    );
  });
});
