/** Verifies continuation storage recovery and the explicit identity-link boundary. */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode, useState } from "react";
import {
  BrowserRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTranslator,
  ensureLanguageLoaded,
  MESSAGES,
  UI_LANGUAGES,
} from "../../i18n";
import {
  clearPendingOnboardingSession,
  completePendingOnboardingContinuation,
  type MessagingContinuationPreview,
  observePendingOnboardingContinuationCompletion,
  type PendingOnboardingSessionState,
  peekPendingOnboardingSession,
  previewPendingOnboardingContinuation,
  storePendingOnboardingSession,
} from "./lib/onboarding-continuation";

const TOKEN = "aaaaaaaa-test-test-test-tokentoken01";
const CONFLICTING_TOKEN = "bbbbbbbb-test-test-test-tokentoken02";
const STORAGE_KEY = "eliza.join.onboardingSession";

function successfulRedemption(sessionId = TOKEN) {
  return {
    success: true,
    data: { sessionId, requiresLogin: false },
  };
}

function actualCompletion() {
  const complete = continuationImplementation.complete;
  if (!complete) throw new Error("Actual continuation helper was not loaded");
  return complete;
}

function actualCompletionObservation() {
  const observe = continuationImplementation.observe;
  if (!observe) throw new Error("Actual continuation helper was not loaded");
  return observe;
}

const auth = vi.hoisted(() => ({ ready: true, authenticated: true }));
const continuationImplementation = vi.hoisted(() => ({
  complete: undefined as
    | undefined
    | typeof import("./lib/onboarding-continuation").completePendingOnboardingContinuation,
  observe: undefined as
    | undefined
    | typeof import("./lib/onboarding-continuation").observePendingOnboardingContinuationCompletion,
}));

vi.mock("./lib/use-join-session", () => ({
  useJoinSessionAuth: () => ({ ...auth }),
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key,
}));

vi.mock("./lib/onboarding-continuation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./lib/onboarding-continuation")>();
  continuationImplementation.complete =
    actual.completePendingOnboardingContinuation;
  continuationImplementation.observe =
    actual.observePendingOnboardingContinuationCompletion;
  return {
    ...actual,
    previewPendingOnboardingContinuation: vi.fn(),
    completePendingOnboardingContinuation: vi.fn(),
    observePendingOnboardingContinuationCompletion: vi.fn(),
  };
});

const { default: GetStartedPage } = await import("./GetStartedPage");

function LoginProbe(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <output data-testid="login-location">
        {location.pathname}
        {location.search}
      </output>
      <button
        type="button"
        onClick={() => {
          auth.ready = true;
          auth.authenticated = true;
          navigate("/get-started");
        }}
      >
        Finish sign-in
      </button>
    </div>
  );
}

function AppRoutes(): React.JSX.Element {
  return (
    <Routes>
      <Route path="/get-started" element={<GetStartedPage />} />
      <Route path="/login" element={<LoginProbe />} />
      <Route path="/join" element={<div data-testid="join-route">join</div>} />
    </Routes>
  );
}

function renderPage(
  entry = `/get-started?onboardingSession=${TOKEN}`,
  strictMode = false,
) {
  window.history.replaceState({ source: "test" }, "", entry);
  const routes = (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
  return render(strictMode ? <StrictMode>{routes}</StrictMode> : routes);
}

function RemountHarness(): React.JSX.Element {
  const [mounted, setMounted] = useState(true);
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="router-location">
        {location.pathname}
        {location.search}
        {location.hash}
      </output>
      <button type="button" onClick={() => setMounted((value) => !value)}>
        {mounted ? "Unmount page" : "Remount page"}
      </button>
      <button
        type="button"
        onClick={() =>
          navigate(
            `/get-started?source=messaging&onboardingSession=${TOKEN}#review`,
          )
        }
      >
        Add continuation
      </button>
      <button
        type="button"
        onClick={() =>
          navigate(
            `/get-started?source=messaging&onboardingSession=${CONFLICTING_TOKEN}#review`,
          )
        }
      >
        Replace continuation
      </button>
      {mounted ? <GetStartedPage /> : null}
    </>
  );
}

beforeEach(() => {
  auth.ready = true;
  auth.authenticated = true;
  vi.mocked(previewPendingOnboardingContinuation).mockReset();
  vi.mocked(previewPendingOnboardingContinuation).mockResolvedValue({
    platform: "discord",
    platformUserId: "1234567890",
    platformDisplayName: "attested-discord-user",
    returnUrl: null,
  });
  vi.mocked(completePendingOnboardingContinuation).mockReset();
  vi.mocked(completePendingOnboardingContinuation).mockImplementation(
    async () => clearPendingOnboardingSession(),
  );
  vi.mocked(observePendingOnboardingContinuationCompletion).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
});

describe("GetStartedPage", () => {
  it("loads the storage failure copy from every supported locale", async () => {
    for (const language of UI_LANGUAGES) {
      await ensureLanguageLoaded(language);
      const translate = createTranslator(language);
      for (const key of [
        "cloud.getStarted.storageErrorTitle",
        "cloud.getStarted.storageErrorBody",
        "cloud.getStarted.storageClearErrorBody",
        "cloud.getStarted.storageCleanupErrorTitle",
        "cloud.getStarted.storageCleanupErrorBody",
      ] as const) {
        expect(MESSAGES[language][key], `${language}:${key}`).toEqual(
          expect.any(String),
        );
        expect(translate(key)).not.toBe(key);
      }
    }
  });

  it("persists before the signed-out login round trip, then previews after sign-in", async () => {
    auth.authenticated = false;
    renderPage();

    expect((await screen.findByTestId("login-location")).textContent).toBe(
      "/login?returnTo=/get-started",
    );
    expect(window.location.search).toBe("?returnTo=/get-started");
    expect(peekPendingOnboardingSession()).toMatchObject({
      presence: "present",
      token: TOKEN,
    });
    expect(previewPendingOnboardingContinuation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    expect(previewPendingOnboardingContinuation).toHaveBeenCalledTimes(1);
    expect(completePendingOnboardingContinuation).not.toHaveBeenCalled();
  });

  it("previews read-only and redeems only after explicit confirmation", async () => {
    renderPage();

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    expect(previewPendingOnboardingContinuation).toHaveBeenCalledWith(TOKEN);
    expect(completePendingOnboardingContinuation).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Discord account/ }),
    );

    expect(await screen.findByText("You're connected")).toBeTruthy();
    expect(completePendingOnboardingContinuation).toHaveBeenCalledTimes(1);
    expect(completePendingOnboardingContinuation).toHaveBeenCalledWith(TOKEN);
    expect(peekPendingOnboardingSession()).toEqual({ presence: "absent" });
  });

  it("announces linking and moves focus to the completed heading", async () => {
    let finishRedemption:
      | ((value: PendingOnboardingSessionState) => void)
      | undefined;
    vi.mocked(completePendingOnboardingContinuation).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRedemption = resolve;
        }),
    );
    renderPage();

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Discord account/ }),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Connecting your account",
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("status")),
    );

    finishRedemption?.({ presence: "absent" });
    const heading = await screen.findByRole("heading", {
      name: "You're connected",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("redeems exactly once when confirmation is clicked twice", async () => {
    let finishRedemption:
      | ((
          value: Awaited<
            ReturnType<typeof completePendingOnboardingContinuation>
          >,
        ) => void)
      | undefined;
    vi.mocked(completePendingOnboardingContinuation).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRedemption = resolve;
        }),
    );
    renderPage();

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    const confirm = screen.getByRole("button", {
      name: /Connect this Discord account/,
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(completePendingOnboardingContinuation).toHaveBeenCalledTimes(1);
    finishRedemption?.({ presence: "absent" });
    expect(await screen.findByText("You're connected")).toBeTruthy();
  });

  it("attaches a remount to the in-flight redemption without another preview or POST", async () => {
    let finishPost: ((value: unknown) => void) | undefined;
    const post = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finishPost = resolve;
        }),
    );
    const complete = actualCompletion();
    vi.mocked(completePendingOnboardingContinuation).mockImplementation(
      (token) => complete(token, { post }),
    );
    const observe = actualCompletionObservation();
    vi.mocked(
      observePendingOnboardingContinuationCompletion,
    ).mockImplementation((token) => observe(token));
    window.history.replaceState(
      { source: "test" },
      "",
      `/get-started?onboardingSession=${TOKEN}`,
    );
    render(
      <BrowserRouter>
        <RemountHarness />
      </BrowserRouter>,
    );

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Discord account/ }),
    );
    expect(post).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Unmount page" }));
    fireEvent.click(screen.getByRole("button", { name: "Remount page" }));
    expect(await screen.findByText("Connecting your account...")).toBeTruthy();
    expect(completePendingOnboardingContinuation).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    finishPost?.(successfulRedemption());
    expect(await screen.findByText("You're connected")).toBeTruthy();
    expect(previewPendingOnboardingContinuation).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("reconciles a flight that settles after remount before any second confirmation", async () => {
    let finishPost: ((value: unknown) => void) | undefined;
    const post = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finishPost = resolve;
        }),
    );
    const complete = actualCompletion();
    const observe = actualCompletionObservation();
    vi.mocked(completePendingOnboardingContinuation).mockImplementation(
      (token) => complete(token, { post }),
    );
    vi.mocked(
      observePendingOnboardingContinuationCompletion,
    ).mockImplementation((token) => observe(token));
    window.history.replaceState(
      { source: "test" },
      "",
      `/get-started?onboardingSession=${TOKEN}`,
    );
    render(
      <BrowserRouter>
        <RemountHarness />
      </BrowserRouter>,
    );

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Discord account/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unmount page" }));
    fireEvent.click(screen.getByRole("button", { name: "Remount page" }));

    finishPost?.(successfulRedemption());
    expect(await screen.findByText("You're connected")).toBeTruthy();
    expect(previewPendingOnboardingContinuation).toHaveBeenCalledTimes(1);
    expect(completePendingOnboardingContinuation).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("recovers a clean redemption that settles while the route is unmounted", async () => {
    let finishPost: ((value: unknown) => void) | undefined;
    const post = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finishPost = resolve;
        }),
    );
    const complete = actualCompletion();
    const observe = actualCompletionObservation();
    vi.mocked(completePendingOnboardingContinuation).mockImplementation(
      (token) => complete(token, { post }),
    );
    vi.mocked(
      observePendingOnboardingContinuationCompletion,
    ).mockImplementation((token) => observe(token));
    window.history.replaceState(
      { source: "test" },
      "",
      `/get-started?onboardingSession=${TOKEN}`,
    );
    render(
      <BrowserRouter>
        <RemountHarness />
      </BrowserRouter>,
    );

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Discord account/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unmount page" }));
    await act(async () => finishPost?.(successfulRedemption()));
    fireEvent.click(screen.getByRole("button", { name: "Remount page" }));

    expect(await screen.findByText("You're connected")).toBeTruthy();
    expect(screen.queryByTestId("join-route")).toBeNull();
    expect(previewPendingOnboardingContinuation).toHaveBeenCalledTimes(1);
    expect(completePendingOnboardingContinuation).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("reloads a committed cleanup receipt without another preview or POST", async () => {
    const post = vi.fn().mockResolvedValue(successfulRedemption());
    const complete = actualCompletion();
    vi.mocked(completePendingOnboardingContinuation).mockImplementation(
      (token) => complete(token, { post }),
    );
    const originalRemoveItem = Storage.prototype.removeItem;
    const removeSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {});
    const firstMount = renderPage();

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Discord account/ }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "You're connected, but cleanup needs attention",
      }),
    ).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
    expect(peekPendingOnboardingSession()).toEqual({
      presence: "present",
      token: TOKEN,
      redemption: "committed",
    });

    firstMount.unmount();
    renderPage("/get-started");
    expect(
      await screen.findByRole("heading", {
        name: "You're connected, but cleanup needs attention",
      }),
    ).toBeTruthy();
    expect(previewPendingOnboardingContinuation).toHaveBeenCalledTimes(1);
    expect(completePendingOnboardingContinuation).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);

    removeSpy.mockImplementation(function (this: Storage, key: string) {
      originalRemoveItem.call(this, key);
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("You're connected")).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("ingests and previews a newer URL token while the prior POST is in flight", async () => {
    const finishPosts: Array<(value: unknown) => void> = [];
    const post = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finishPosts.push(resolve);
        }),
    );
    const complete = actualCompletion();
    vi.mocked(completePendingOnboardingContinuation).mockImplementation(
      (token) => complete(token, { post }),
    );
    vi.mocked(previewPendingOnboardingContinuation).mockImplementation(
      async (token) => ({
        platform: "discord",
        platformUserId: token === TOKEN ? "1234567890" : "9876543210",
        platformDisplayName:
          token === TOKEN ? "attested-discord-user" : "new-discord-user",
        returnUrl: null,
      }),
    );
    window.history.replaceState(
      { source: "test" },
      "",
      `/get-started?onboardingSession=${TOKEN}`,
    );
    render(
      <BrowserRouter>
        <RemountHarness />
      </BrowserRouter>,
    );

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Discord account/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Replace continuation" }),
    );

    expect(await screen.findByText("new-discord-user")).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
    expect(peekPendingOnboardingSession()).toEqual({
      presence: "present",
      token: CONFLICTING_TOKEN,
      redemption: "pending",
    });
    expect(previewPendingOnboardingContinuation).toHaveBeenLastCalledWith(
      CONFLICTING_TOKEN,
    );
    expect(post).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Connect this Discord account/,
      }),
    );
    expect(post).toHaveBeenCalledTimes(2);

    await act(async () => {
      finishPosts[0]?.(successfulRedemption());
    });
    expect(screen.queryByText("You're connected")).toBeNull();
    expect(screen.getByText("Connecting your account...")).toBeTruthy();

    await act(async () => {
      finishPosts[1]?.(successfulRedemption(CONFLICTING_TOKEN));
    });
    expect(await screen.findByText("You're connected")).toBeTruthy();
    expect(peekPendingOnboardingSession()).toEqual({ presence: "absent" });
  });

  it("ignores a delayed preview for A after router ingestion confirms B", async () => {
    let finishPreviewA:
      | ((value: MessagingContinuationPreview) => void)
      | undefined;
    vi.mocked(previewPendingOnboardingContinuation).mockImplementation(
      (token) => {
        if (token === TOKEN) {
          return new Promise((resolve) => {
            finishPreviewA = resolve;
          });
        }
        return Promise.resolve({
          platform: "discord",
          platformUserId: "9876543210",
          platformDisplayName: "new-discord-user",
          returnUrl: null,
        });
      },
    );
    window.history.replaceState(
      { source: "test" },
      "",
      `/get-started?onboardingSession=${TOKEN}`,
    );
    render(
      <BrowserRouter>
        <RemountHarness />
      </BrowserRouter>,
    );

    await waitFor(() =>
      expect(previewPendingOnboardingContinuation).toHaveBeenCalledWith(TOKEN),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Replace continuation" }),
    );
    expect(await screen.findByText("new-discord-user")).toBeTruthy();

    await act(async () => {
      finishPreviewA?.({
        platform: "discord",
        platformUserId: "1234567890",
        platformDisplayName: "attested-discord-user",
        returnUrl: null,
      });
    });

    expect(screen.getByText("new-discord-user")).toBeTruthy();
    expect(screen.queryByText("attested-discord-user")).toBeNull();
    expect(completePendingOnboardingContinuation).not.toHaveBeenCalled();
  });

  it("keeps B completed when its POST resolves before stale A", async () => {
    const finishPosts: Array<(value: unknown) => void> = [];
    const post = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finishPosts.push(resolve);
        }),
    );
    const complete = actualCompletion();
    vi.mocked(completePendingOnboardingContinuation).mockImplementation(
      (token) => complete(token, { post }),
    );
    vi.mocked(previewPendingOnboardingContinuation).mockImplementation(
      async (token) => ({
        platform: "discord",
        platformUserId: token === TOKEN ? "1234567890" : "9876543210",
        platformDisplayName:
          token === TOKEN ? "attested-discord-user" : "new-discord-user",
        returnUrl: null,
      }),
    );
    window.history.replaceState(
      { source: "test" },
      "",
      `/get-started?onboardingSession=${TOKEN}`,
    );
    render(
      <BrowserRouter>
        <RemountHarness />
      </BrowserRouter>,
    );

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Discord account/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Replace continuation" }),
    );
    expect(await screen.findByText("new-discord-user")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Discord account/ }),
    );
    expect(post).toHaveBeenCalledTimes(2);

    await act(async () => {
      finishPosts[1]?.(successfulRedemption(CONFLICTING_TOKEN));
    });
    expect(await screen.findByText("You're connected")).toBeTruthy();

    await act(async () => {
      finishPosts[0]?.(successfulRedemption());
    });
    expect(screen.getByText("You're connected")).toBeTruthy();
    expect(
      screen.queryByRole("heading", {
        name: "You're connected, but cleanup needs attention",
      }),
    ).toBeNull();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("ignores A redemption failure after B is previewed and requires B confirmation", async () => {
    let rejectPost: ((reason?: unknown) => void) | undefined;
    let postNumber = 0;
    const post = vi.fn(() => {
      postNumber += 1;
      if (postNumber > 1) {
        return Promise.resolve(successfulRedemption(CONFLICTING_TOKEN));
      }
      return new Promise<unknown>((_resolve, reject) => {
        rejectPost = reject;
      });
    });
    const complete = actualCompletion();
    vi.mocked(completePendingOnboardingContinuation).mockImplementation(
      (token) => complete(token, { post }),
    );
    vi.mocked(previewPendingOnboardingContinuation).mockImplementation(
      async (token) => ({
        platform: "discord",
        platformUserId: token === TOKEN ? "1234567890" : "9876543210",
        platformDisplayName:
          token === TOKEN ? "attested-discord-user" : "new-discord-user",
        returnUrl: null,
      }),
    );
    window.history.replaceState(
      { source: "test" },
      "",
      `/get-started?onboardingSession=${TOKEN}`,
    );
    render(
      <BrowserRouter>
        <RemountHarness />
      </BrowserRouter>,
    );

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Discord account/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Replace continuation" }),
    );
    expect(await screen.findByText("new-discord-user")).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectPost?.(new Error("ambiguous A response"));
    });

    expect(screen.getByText("new-discord-user")).toBeTruthy();
    expect(screen.queryByText("ambiguous A response")).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Discord account/ }),
    );
    expect(post).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("You're connected")).toBeTruthy();
  });

  it.each([
    {
      condition: "absent",
      mutate: () => {
        window.localStorage.clear();
        window.sessionStorage.clear();
        return () => {};
      },
    },
    {
      condition: "conflicting",
      mutate: () => {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            token: CONFLICTING_TOKEN,
            expiresAt: Date.now() + 60_000,
          }),
        );
        return () => {};
      },
    },
    {
      condition: "unreadable",
      mutate: () => {
        const spy = vi
          .spyOn(Storage.prototype, "getItem")
          .mockImplementation(() => {
            throw new Error("storage unreadable");
          });
        return () => spy.mockRestore();
      },
    },
  ])(
    "blocks redemption before POST when stored presence becomes $condition",
    async ({ mutate }) => {
      renderPage();
      expect(await screen.findByText("attested-discord-user")).toBeTruthy();

      const restore = mutate();
      fireEvent.click(
        screen.getByRole("button", {
          name: /Connect this Discord account/,
        }),
      );
      restore();

      expect(
        await screen.findByRole("heading", {
          name: "Your browser could not verify this connection",
        }),
      ).toBeTruthy();
      expect(completePendingOnboardingContinuation).not.toHaveBeenCalled();
      expect(screen.queryByText("You're connected")).toBeNull();
    },
  );

  it("revalidates storage before the read-only preview", async () => {
    auth.ready = false;
    const rendered = renderPage();
    await waitFor(() => expect(window.location.search).toBe(""));
    window.localStorage.clear();
    window.sessionStorage.clear();

    auth.ready = true;
    rendered.rerender(
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Your browser could not verify this connection",
      }),
    ).toBeTruthy();
    expect(previewPendingOnboardingContinuation).not.toHaveBeenCalled();
  });

  it("retries preview with GET semantics and never confirms implicitly", async () => {
    vi.mocked(previewPendingOnboardingContinuation)
      .mockRejectedValueOnce(new Error("preview temporarily unavailable"))
      .mockResolvedValueOnce({
        platform: "discord",
        platformUserId: "1234567890",
        platformDisplayName: "attested-discord-user",
        returnUrl: null,
      });
    renderPage();

    expect(
      await screen.findByText("preview temporarily unavailable"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    expect(previewPendingOnboardingContinuation).toHaveBeenCalledTimes(2);
    expect(completePendingOnboardingContinuation).not.toHaveBeenCalled();
  });

  it("retries a failed explicit redemption and preserves the validated return URL", async () => {
    vi.mocked(previewPendingOnboardingContinuation).mockResolvedValue({
      platform: "blooio",
      platformUserId: "+14155550123",
      platformDisplayName: "Shaw",
      returnUrl: "sms:+18087881821",
    });
    vi.mocked(completePendingOnboardingContinuation)
      .mockRejectedValueOnce(new Error("redeem temporarily unavailable"))
      .mockImplementationOnce(async () => clearPendingOnboardingSession());
    renderPage();

    expect(await screen.findByText("Shaw")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this iMessage account/ }),
    );
    expect(
      await screen.findByText("redeem temporarily unavailable"),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "redeem temporarily unavailable",
    );
    const retry = screen.getByRole("button", { name: "Try again" });
    await waitFor(() => expect(document.activeElement).toBe(retry));
    fireEvent.click(retry);

    expect(await screen.findByText("You're connected")).toBeTruthy();
    expect(completePendingOnboardingContinuation).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getByRole("link", { name: "Back to iMessage" })
        .getAttribute("href"),
    ).toBe("sms:+18087881821");
  });

  it("retries verified cleanup without repeating a successful redemption", async () => {
    vi.mocked(completePendingOnboardingContinuation).mockResolvedValue({
      presence: "present",
      token: TOKEN,
      redemption: "committed",
    });
    renderPage();

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Discord account/ }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "You're connected, but cleanup needs attention",
      }),
    ).toBeTruthy();
    const cleanupAlert = screen.getByRole("alert");
    expect(cleanupAlert.textContent).toContain("Your account is connected");
    expect(screen.getByText(/Your account is connected/).textContent).toContain(
      "will not reconnect the account",
    );
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();

    const cleanupRetry = screen.getByRole("button", { name: "Try again" });
    await waitFor(() => expect(document.activeElement).toBe(cleanupRetry));
    fireEvent.click(cleanupRetry);

    expect(await screen.findByText("You're connected")).toBeTruthy();
    expect(completePendingOnboardingContinuation).toHaveBeenCalledTimes(1);
  });

  it("keeps the URL and blocks login, preview, and /join when no write verifies", async () => {
    auth.authenticated = false;
    const setSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage blocked");
      });
    renderPage();

    expect(
      await screen.findByRole("heading", {
        name: "Your browser could not verify this connection",
      }),
    ).toBeTruthy();
    expect(window.location.search).toContain(`onboardingSession=${TOKEN}`);
    expect(screen.queryByTestId("login-location")).toBeNull();
    expect(screen.queryByTestId("join-route")).toBeNull();
    expect(previewPendingOnboardingContinuation).not.toHaveBeenCalled();
    expect(completePendingOnboardingContinuation).not.toHaveBeenCalled();

    setSpy.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("login-location")).toBeTruthy();
    expect(window.location.search).toBe("?returnTo=/get-started");
  });

  it("can dismiss a persist failure only after both stores verify empty", async () => {
    const setSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage blocked");
      });
    renderPage();

    expect(
      await screen.findByRole("heading", {
        name: "Your browser could not verify this connection",
      }),
    ).toBeTruthy();
    setSpy.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(await screen.findByTestId("join-route")).toBeTruthy();
    expect(window.location.search).toBe("");
    expect(peekPendingOnboardingSession()).toEqual({ presence: "absent" });
  });

  it("blocks an unreadable residual token and recovers with a peek retry", async () => {
    storePendingOnboardingSession(TOKEN);
    window.sessionStorage.clear();
    const originalGetItem = Storage.prototype.getItem;
    const getSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (this === window.localStorage) throw new Error("unreadable");
        return originalGetItem.call(this, key);
      });
    renderPage("/get-started");

    expect(
      await screen.findByRole("heading", {
        name: "Your browser could not verify this connection",
      }),
    ).toBeTruthy();
    expect(screen.queryByTestId("join-route")).toBeNull();
    expect(previewPendingOnboardingContinuation).not.toHaveBeenCalled();

    getSpy.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
  });

  it("keeps dismissal blocked while removal leaves a residual token", async () => {
    storePendingOnboardingSession(TOKEN);
    window.sessionStorage.clear();
    const originalGetItem = Storage.prototype.getItem;
    const getSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (this === window.localStorage) throw new Error("unreadable");
        return originalGetItem.call(this, key);
      });
    renderPage("/get-started");
    expect(
      await screen.findByRole("heading", {
        name: "Your browser could not verify this connection",
      }),
    ).toBeTruthy();
    getSpy.mockRestore();

    const originalRemoveItem = Storage.prototype.removeItem;
    const removeSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (this === window.localStorage) return;
        originalRemoveItem.call(this, key);
      });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(
      screen.getByRole("heading", {
        name: "Your browser could not verify this connection",
      }),
    ).toBeTruthy();
    expect(screen.queryByTestId("join-route")).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();

    removeSpy.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("join-route")).toBeTruthy();
  });

  it("removes the router token once and never renews it across StrictMode remounts", async () => {
    const initialTime = Date.parse("2026-08-13T12:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(initialTime);
    const originalSetItem = Storage.prototype.setItem;
    const writes: Array<{ storage: Storage; value: string }> = [];
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === STORAGE_KEY) writes.push({ storage: this, value });
      originalSetItem.call(this, key, value);
    });
    window.history.replaceState(
      { source: "test" },
      "",
      `/get-started?source=messaging&onboardingSession=${TOKEN}#review`,
    );

    render(
      <StrictMode>
        <BrowserRouter>
          <RemountHarness />
        </BrowserRouter>
      </StrictMode>,
    );

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("router-location").textContent).toBe(
        "/get-started?source=messaging#review",
      ),
    );
    expect(window.location.search).toBe("?source=messaging");
    expect(window.location.hash).toBe("#review");
    expect(writes).toHaveLength(2);
    const localRecord = window.localStorage.getItem(STORAGE_KEY);
    const sessionRecord = window.sessionStorage.getItem(STORAGE_KEY);

    nowSpy.mockReturnValue(initialTime + 30 * 60 * 1000);
    fireEvent.click(screen.getByRole("button", { name: "Unmount page" }));
    fireEvent.click(screen.getByRole("button", { name: "Remount page" }));

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    expect(writes).toHaveLength(2);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(localRecord);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(sessionRecord);
  });

  it("processes a continuation that arrives on the mounted route", async () => {
    auth.ready = false;
    window.history.replaceState(null, "", "/get-started?source=messaging");
    const page = () => (
      <BrowserRouter>
        <RemountHarness />
      </BrowserRouter>
    );
    const rendered = render(page());

    fireEvent.click(screen.getByRole("button", { name: "Add continuation" }));
    await waitFor(() =>
      expect(screen.getByTestId("router-location").textContent).toBe(
        "/get-started?source=messaging#review",
      ),
    );
    auth.ready = true;
    auth.authenticated = true;
    rendered.rerender(page());

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    expect(peekPendingOnboardingSession()).toMatchObject({
      presence: "present",
      token: TOKEN,
    });
    expect(completePendingOnboardingContinuation).not.toHaveBeenCalled();
  });
});
