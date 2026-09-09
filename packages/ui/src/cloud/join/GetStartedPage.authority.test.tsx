/** Exercises the actual Telegram confirmation page and session transaction with synthetic HTTP; only session readiness and the read-only identity preview are fixtures. */
// @vitest-environment jsdom

import {
  clearStoredStewardToken,
  getStewardTabSessionAuthorityCoordinator,
  readStoredStewardToken,
  resetStewardTabSessionAuthorityCoordinatorForTests,
  STEWARD_TOKEN_KEY,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  peekPendingOnboardingSession,
  storePendingOnboardingSession,
  TELEGRAM_ACCOUNT_CLAIM_PURPOSE,
} from "./lib/onboarding-continuation";

vi.mock("./lib/use-join-session", () => ({
  useJoinSessionAuth: () => ({ ready: true, authenticated: true }),
}));
vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));
vi.mock("./lib/onboarding-continuation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/onboarding-continuation")>()),
  previewPendingOnboardingContinuation: async () => ({
    platform: "telegram",
    platformUserId: "123456789",
    platformDisplayName: "Fixture Telegram",
    returnUrl: null,
  }),
}));

import GetStartedPage from "./GetStartedPage";

const continuation = "telegram-authority-fixture-00000001";
let pending: ReturnType<typeof Promise.withResolvers<Response>>;
let requests: RequestInit[];

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
  await writeStoredStewardToken("current-account-fixture");
  storePendingOnboardingSession(continuation, TELEGRAM_ACCOUNT_CLAIM_PURPOSE);
  pending = Promise.withResolvers<Response>();
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith("/api/auth/steward-session") || !init)
        throw new Error("Unexpected fixture HTTP");
      requests.push(init);
      return pending.promise;
    }),
  );
});
afterEach(() => {
  cleanup();
  pending.resolve(Response.json({ ok: true }));
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  resetStewardTabSessionAuthorityCoordinatorForTests();
});
async function mount() {
  const view = render(
    <MemoryRouter initialEntries={["/get-started"]}>
      <Routes>
        <Route path="/get-started" element={<GetStartedPage />} />
        <Route path="/join" element={<h1>Join destination fixture</h1>} />
      </Routes>
    </MemoryRouter>,
  );
  const confirm = await screen.findByRole("button", {
    name: "Connect this Telegram account",
  });
  expect(requests).toHaveLength(0);
  return { view, confirm };
}

it("requires the displayed confirmation and acknowledged transaction before navigation", async () => {
  const { confirm } = await mount();
  fireEvent.click(confirm);
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(JSON.parse(String(requests[0].body))).toEqual({
    token: "current-account-fixture",
    telegramContinuation: continuation,
    telegramClaimConfirmation: "explicit",
  });
  expect(
    screen.queryByRole("heading", { name: "Join destination fixture" }),
  ).toBeNull();
  await act(async () => {
    pending.resolve(Response.json({ ok: true }));
  });
  await screen.findByRole("heading", { name: "Join destination fixture" });
  expect(peekPendingOnboardingSession()).toBeNull();
});

it("preserves the continuation and presents recovery after a legacy account replacement", async () => {
  const { confirm } = await mount();
  fireEvent.click(confirm);
  await waitFor(() => expect(requests).toHaveLength(1));
  localStorage.setItem(STEWARD_TOKEN_KEY, "replacement-account-fixture");
  await act(async () => {
    pending.resolve(Response.json({ ok: true }));
  });
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Your sign-in changed",
  );
  expect(
    screen.queryByRole("heading", { name: "Join destination fixture" }),
  ).toBeNull();
  expect(readStoredStewardToken()).toBe("replacement-account-fixture");
  expect(peekPendingOnboardingSession()).toBe(continuation);
});

it("rejects a click queued behind logout without a claim POST", async () => {
  const { confirm } = await mount();
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  const blocker = getStewardTabSessionAuthorityCoordinator().runExclusive({
    kind: "session-sync",
    work: async () => {
      entered.resolve();
      await held.promise;
    },
  });
  await entered.promise;
  const logout = clearStoredStewardToken();
  fireEvent.click(confirm);
  await act(async () => {
    held.resolve();
    await blocker;
    await logout;
  });
  await screen.findByRole("alert");
  expect(requests).toHaveLength(0);
  expect(peekPendingOnboardingSession()).toBe(continuation);
  expect(readStoredStewardToken()).toBeNull();
});

it.each(["unmount", "pagehide"])(
  "cancels on %s and ignores a late acknowledgement",
  async (end) => {
    const { view, confirm } = await mount();
    fireEvent.click(confirm);
    await waitFor(() => expect(requests).toHaveLength(1));
    if (end === "unmount") view.unmount();
    else act(() => window.dispatchEvent(new Event("pagehide")));
    expect(requests[0].signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(Response.json({ ok: true }));
      await getStewardTabSessionAuthorityCoordinator().runExclusive({
        kind: "session-sync",
        work: async () => {},
      });
    });
    expect(peekPendingOnboardingSession()).toBe(continuation);
    expect(readStoredStewardToken()).toBe("current-account-fixture");
    if (end === "pagehide") {
      act(() => window.dispatchEvent(new Event("pageshow")));
      expect(requests).toHaveLength(1);
      pending = Promise.withResolvers<Response>();
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Connect this Telegram account",
        }),
      );
      await waitFor(() => expect(requests).toHaveLength(2));
      await act(async () => pending.resolve(Response.json({ ok: true })));
      await screen.findByRole("heading", { name: "Join destination fixture" });
      expect(peekPendingOnboardingSession()).toBeNull();
    }
  },
);
