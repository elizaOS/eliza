/**
 * Steward marker and session-authority contracts in jsdom, including the
 * replacement-safe replay seam; browser storage and transport are local fakes.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetStewardSessionAuthorityForTests,
  clearStoredStewardToken,
  getStewardSessionTransitionSnapshot,
  hasStewardAuthedCookie,
  type StewardSessionTransition,
  stewardAuthedCookieName,
  subscribeStewardSessionTransitions,
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
    __resetStewardSessionAuthorityForTests();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("publishes and persists ordered immutable non-secret transitions", () => {
    const transitions: StewardSessionTransition[] = [];
    const unsubscribe = subscribeStewardSessionTransitions((transition) =>
      transitions.push(transition),
    );

    writeStoredStewardToken("never-publish-this-token");
    clearStoredStewardToken();

    unsubscribe();
    expect(transitions.map(({ kind }) => kind)).toEqual(["present", "cleared"]);
    expect(transitions[1]?.revision).toBeGreaterThan(
      transitions[0]?.revision ?? 0,
    );
    expect(getStewardSessionTransitionSnapshot()).toBe(transitions[1]);
    expect(Object.isFrozen(transitions[1])).toBe(true);
    expect(JSON.stringify(transitions)).not.toContain(
      "never-publish-this-token",
    );
  });

  it("publishes an explicit clear for a cookie-only session", () => {
    const transitions: StewardSessionTransition[] = [];
    const unsubscribe = subscribeStewardSessionTransitions((transition) =>
      transitions.push(transition),
    );

    expect(window.localStorage.getItem("steward_session_token")).toBeNull();
    clearStoredStewardToken();

    unsubscribe();
    expect(transitions.at(-1)?.kind).toBe("cleared");
  });

  it("replays the latest transition to a replacement subscriber", () => {
    writeStoredStewardToken("not-in-the-snapshot");
    const firstRevision = getStewardSessionTransitionSnapshot()?.revision ?? 0;
    const firstSubscriber: StewardSessionTransition[] = [];
    const unsubscribeFirst = subscribeStewardSessionTransitions((transition) =>
      firstSubscriber.push(transition),
    );
    expect(firstSubscriber.map(({ kind }) => kind)).toEqual(["present"]);
    unsubscribeFirst();

    clearStoredStewardToken();
    const replacementSubscriber: StewardSessionTransition[] = [];
    const unsubscribeReplacement = subscribeStewardSessionTransitions(
      (transition) => replacementSubscriber.push(transition),
    );

    expect(replacementSubscriber).toEqual([
      expect.objectContaining({ kind: "cleared" }),
    ]);
    expect(replacementSubscriber[0]?.revision).toBeGreaterThan(firstRevision);
    expect(JSON.stringify(replacementSubscriber)).not.toContain(
      "not-in-the-snapshot",
    );
    unsubscribeReplacement();
  });

  it("publishes a synchronous clear when browser storage removal fails", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const transitions: StewardSessionTransition[] = [];
    const unsubscribe = subscribeStewardSessionTransitions((transition) =>
      transitions.push(transition),
    );

    expect(() => clearStoredStewardToken()).toThrow(AggregateError);

    expect(transitions.at(-1)?.kind).toBe("cleared");
    expect(getStewardSessionTransitionSnapshot()).toBe(transitions.at(-1));
    unsubscribe();
  });

  it("completes invalidation for other subscribers before surfacing a listener failure", () => {
    const observed: StewardSessionTransition[] = [];
    const unsubscribeFailing = subscribeStewardSessionTransitions(() => {
      throw new Error("observer failed");
    });
    const unsubscribeObserved = subscribeStewardSessionTransitions(
      (transition) => observed.push(transition),
    );

    expect(() => clearStoredStewardToken()).toThrow(AggregateError);
    expect(observed.at(-1)?.kind).toBe("cleared");
    expect(getStewardSessionTransitionSnapshot()).toBe(observed.at(-1));

    unsubscribeFailing();
    unsubscribeObserved();
  });
});
