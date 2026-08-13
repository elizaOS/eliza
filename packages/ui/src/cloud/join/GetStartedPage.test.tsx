/** Verifies the fail-closed continuation and explicit Cloud setup boundary. */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTranslator,
  ensureLanguageLoaded,
  MESSAGES,
  UI_LANGUAGES,
} from "../../i18n";
import {
  peekPendingOnboardingSession,
  storePendingOnboardingSession,
} from "./lib/onboarding-continuation";

const TOKEN = "aaaaaaaa-test-test-test-tokentoken01";
const GET_STARTED_KEYS = [
  "cloud.getStarted.continuationCancel",
  "cloud.getStarted.continuationInvalidBody",
  "cloud.getStarted.continuationInvalidTitle",
  "cloud.getStarted.continuationPausedBody",
  "cloud.getStarted.continuationPausedTitle",
  "cloud.getStarted.continuationStorageErrorBody",
  "cloud.getStarted.continuationStorageErrorTitle",
  "cloud.getStarted.setupBody",
  "cloud.getStarted.setupCta",
  "cloud.getStarted.setupTitle",
] as const;

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT:
    () =>
    (
      key: string,
      options?: { defaultValue?: string; [name: string]: unknown },
    ) =>
      options?.defaultValue ?? key,
}));

const { default: GetStartedPage } = await import("./GetStartedPage");

function renderPage(entry = `/get-started?onboardingSession=${TOKEN}`) {
  window.history.replaceState(null, "", entry);
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/get-started" element={<GetStartedPage />} />
        <Route
          path="/join"
          element={<div data-testid="join-route">join</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("GetStartedPage", () => {
  it("loads every production state from every supported locale", async () => {
    for (const language of UI_LANGUAGES) {
      await ensureLanguageLoaded(language);
      const translate = createTranslator(language);
      for (const key of GET_STARTED_KEYS) {
        expect(MESSAGES[language][key], `${language}:${key}`).toEqual(
          expect.any(String),
        );
        expect(MESSAGES[language][key].trim(), `${language}:${key}`).not.toBe(
          "",
        );
        expect(translate(key)).not.toBe(key);
      }
    }
  });

  it.each([
    ["signed-out bare", "/get-started", false, "Set up Eliza Cloud"],
    ["signed-in bare", "/get-started", true, "Set up Eliza Cloud"],
    [
      "signed-out continuation",
      `/get-started?onboardingSession=${TOKEN}`,
      false,
      "Messaging connection paused",
    ],
    [
      "signed-in continuation",
      `/get-started?onboardingSession=${TOKEN}`,
      true,
      "Messaging connection paused",
    ],
  ])(
    "makes no initial network request for %s entry",
    (_name, entry, signedIn, heading) => {
      if (signedIn) {
        window.localStorage.setItem(
          "steward_session_token",
          "signed-in-test-token",
        );
      }
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      renderPage(entry);

      expect(screen.getByRole("heading", { name: heading })).toBe(
        document.activeElement,
      );
      expect(screen.queryByTestId("join-route")).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("enters the existing Cloud setup flow only after explicit consent", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderPage("/get-started");

    fireEvent.click(
      screen.getByRole("link", { name: "Continue to Cloud setup" }),
    );

    expect(screen.getByTestId("join-route")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retains a valid continuation locally without verifying or linking it", () => {
    renderPage();

    expect(
      screen.getByText(
        "This page did not verify or link this connection. The current Cloud flow can also add credit and start Dedicated compute, so messaging connections are unavailable until a safe linking flow ships. Keep chatting in your messaging app for now.",
      ),
    ).toBeTruthy();
    expect(peekPendingOnboardingSession()).toBe(TOKEN);
    expect(window.location.search).toBe("");
  });

  it("fails closed on a malformed raw continuation", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderPage("/get-started?onboardingSession=short");

    expect(
      screen.getByRole("heading", {
        name: "This connection link isn't valid",
      }),
    ).toBe(document.activeElement);
    expect(screen.queryByTestId("join-route")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("restores a persisted continuation without a network request", () => {
    storePendingOnboardingSession(TOKEN);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    renderPage("/get-started");

    expect(
      screen.getByRole("heading", { name: "Messaging connection paused" }),
    ).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["local", () => window.localStorage, () => window.sessionStorage],
    ["session", () => window.sessionStorage, () => window.localStorage],
  ])(
    "strips the URL after a verified %s-storage partial write",
    (_blockedName, blockedStorage, retainedStorage) => {
      const originalSetItem = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        if (this === blockedStorage()) throw new Error("storage blocked");
        originalSetItem.call(this, key, value);
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      renderPage();

      expect(
        screen.getByRole("heading", { name: "Messaging connection paused" }),
      ).toBeTruthy();
      expect(window.location.search).toBe("");
      expect(retainedStorage().length).toBe(1);
      expect(peekPendingOnboardingSession()).toBe(TOKEN);
      expect(screen.queryByTestId("join-route")).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("keeps the URL and shows a designed failure when neither store persists", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    renderPage();

    expect(
      screen.getByRole("heading", {
        name: "Browser storage blocked this connection",
      }),
    ).toBe(document.activeElement);
    expect(window.location.search).toContain(`onboardingSession=${TOKEN}`);
    expect(peekPendingOnboardingSession()).toBeNull();
    expect(screen.queryByTestId("join-route")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dismisses and forgets a continuation before showing setup consent", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderPage();
    expect(peekPendingOnboardingSession()).toBe(TOKEN);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss connection" }));

    expect(peekPendingOnboardingSession()).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.location.search).toBe("");
    expect(screen.getByRole("heading", { name: "Set up Eliza Cloud" })).toBe(
      document.activeElement,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["local", true, false],
    ["session", false, true],
    ["both", true, true],
  ])(
    "keeps the connection blocked when %s storage removal leaves a residual copy",
    (_name, blockLocal, blockSession) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      renderPage();
      const originalRemoveItem = Storage.prototype.removeItem;
      const removeSpy = vi
        .spyOn(Storage.prototype, "removeItem")
        .mockImplementation(function (this: Storage, key: string) {
          if (
            (blockLocal && this === window.localStorage) ||
            (blockSession && this === window.sessionStorage)
          ) {
            return;
          }
          originalRemoveItem.call(this, key);
        });

      fireEvent.click(
        screen.getByRole("button", { name: "Dismiss connection" }),
      );

      expect(
        screen.getByRole("heading", {
          name: "Browser storage blocked this connection",
        }),
      ).toBe(document.activeElement);
      expect(
        screen.queryByRole("heading", { name: "Set up Eliza Cloud" }),
      ).toBeNull();
      expect(window.localStorage.length).toBe(blockLocal ? 1 : 0);
      expect(window.sessionStorage.length).toBe(blockSession ? 1 : 0);
      expect(fetchSpy).not.toHaveBeenCalled();

      removeSpy.mockRestore();
      fireEvent.click(
        screen.getByRole("button", { name: "Dismiss connection" }),
      );
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
      expect(screen.getByRole("heading", { name: "Set up Eliza Cloud" })).toBe(
        document.activeElement,
      );
    },
  );
});
