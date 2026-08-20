/** Regression coverage for one-shot messaging onboarding continuation redemption. */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingOnboardingSession,
  completePendingOnboardingContinuation,
  peekPendingOnboardingSession,
  previewPendingOnboardingContinuation,
  storePendingOnboardingSession,
  TELEGRAM_ACCOUNT_CLAIM_PURPOSE,
} from "./lib/onboarding-continuation";

const pageState = vi.hoisted(() => ({
  session: { ready: true, authenticated: true },
  persistenceBlocked: false,
}));

const TOKEN = "aaaaaaaa-test-test-test-tokentoken01";
const confirmTelegramAccountClaim = vi.fn(async () => {
  clearPendingOnboardingSession();
});

vi.mock("@elizaos/shared/steward-session-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@elizaos/shared/steward-session-client")
  >()),
  readStoredStewardToken: () => "existing-steward-token",
}));

vi.mock("../public-pages/lib/steward-session", () => ({
  confirmTelegramAccountClaim,
}));

vi.mock("./lib/use-join-session", () => ({
  useJoinSessionAuth: () => pageState.session,
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("./lib/onboarding-continuation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./lib/onboarding-continuation")>();
  return {
    ...actual,
    storePendingOnboardingSession: vi.fn(
      (token: string, purpose?: "link" | "telegram-account-claim") =>
        pageState.persistenceBlocked
          ? false
          : actual.storePendingOnboardingSession(token, purpose),
    ),
    previewPendingOnboardingContinuation: vi.fn(async () => ({
      platform: "discord" as const,
      platformUserId: "1234567890",
      platformDisplayName: "attested-discord-user",
      returnUrl: null,
    })),
    completePendingOnboardingContinuation: vi.fn(async () => {
      actual.clearPendingOnboardingSession();
    }),
  };
});

const { default: GetStartedPage } = await import("./GetStartedPage");

function LoginReturnFixture(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        pageState.session = { ready: true, authenticated: true };
        navigate("/get-started");
      }}
    >
      Finish login
    </button>
  );
}

beforeEach(() => {
  pageState.session = { ready: true, authenticated: true };
  pageState.persistenceBlocked = false;
  vi.mocked(storePendingOnboardingSession).mockClear();
  confirmTelegramAccountClaim.mockClear();
  vi.mocked(previewPendingOnboardingContinuation).mockReset();
  vi.mocked(previewPendingOnboardingContinuation).mockResolvedValue({
    platform: "discord",
    platformUserId: "1234567890",
    platformDisplayName: "attested-discord-user",
    returnUrl: null,
  });
  vi.mocked(completePendingOnboardingContinuation).mockReset();
  vi.mocked(completePendingOnboardingContinuation).mockImplementation(
    async () => {
      clearPendingOnboardingSession();
    },
  );
});

afterEach(() => {
  cleanup();
  clearPendingOnboardingSession();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  delete document.documentElement.dataset.getStartedDocument;
});

describe("GetStartedPage", () => {
  it("preserves a signed-out Telegram claim through login until preview and confirmation", async () => {
    pageState.session = { ready: true, authenticated: false };
    vi.mocked(previewPendingOnboardingContinuation).mockResolvedValue({
      platform: "telegram",
      platformUserId: "123456789",
      platformDisplayName: "attested-telegram-user",
      returnUrl: null,
    });
    const entry = `/get-started?onboardingSession=${TOKEN}&accountClaim=telegram`;
    window.history.replaceState(null, "", entry);

    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/get-started" element={<GetStartedPage />} />
          <Route path="/login" element={<LoginReturnFixture />} />
          <Route path="/join" element={<div>join</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Finish login")).toBeTruthy();
    expect(confirmTelegramAccountClaim).not.toHaveBeenCalled();
    expect(peekPendingOnboardingSession(TELEGRAM_ACCOUNT_CLAIM_PURPOSE)).toBe(
      TOKEN,
    );

    fireEvent.click(screen.getByText("Finish login"));
    expect(await screen.findByText("attested-telegram-user")).toBeTruthy();
    expect(confirmTelegramAccountClaim).not.toHaveBeenCalled();
    expect(peekPendingOnboardingSession(TELEGRAM_ACCOUNT_CLAIM_PURPOSE)).toBe(
      TOKEN,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Telegram account/ }),
    );
    expect(await screen.findByText("join")).toBeTruthy();
    expect(confirmTelegramAccountClaim).toHaveBeenCalledTimes(1);
    expect(confirmTelegramAccountClaim).toHaveBeenCalledWith(
      "existing-steward-token",
      TOKEN,
    );
    expect(
      peekPendingOnboardingSession(TELEGRAM_ACCOUNT_CLAIM_PURPOSE),
    ).toBeNull();
  });

  it("does not restore a URL continuation after a successful redemption rerender", async () => {
    const entry = `/get-started?onboardingSession=${TOKEN}`;
    window.history.replaceState(null, "", entry);
    document.documentElement.dataset.getStartedDocument = "survived";

    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/get-started" element={<GetStartedPage />} />
          <Route path="/join" element={<div>join</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    expect(screen.queryByText("You're connected")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Discord account/ }),
    );
    expect(await screen.findByText("You're connected")).toBeTruthy();
    await waitFor(() => {
      expect(peekPendingOnboardingSession()).toBeNull();
      expect(window.sessionStorage.length).toBe(0);
      expect(window.localStorage.length).toBe(0);
    });
    expect(window.location.search).not.toContain("onboardingSession");
    fireEvent.click(
      screen.getByRole("button", { name: "Or chat here instead" }),
    );
    expect(await screen.findByText("join")).toBeTruthy();
    expect(document.documentElement.dataset.getStartedDocument).toBe(
      "survived",
    );
  });

  it("retries blocked Telegram-token persistence without reloading the document", async () => {
    pageState.session = { ready: true, authenticated: false };
    pageState.persistenceBlocked = true;
    const entry = `/get-started?onboardingSession=${TOKEN}&accountClaim=telegram`;
    window.history.replaceState(null, "", entry);
    document.documentElement.dataset.getStartedDocument = "survived";

    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/get-started" element={<GetStartedPage />} />
          <Route path="/login" element={<div>login without reload</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(
        "Allow browser storage, then try again. Your Telegram account was not changed.",
      ),
    ).toBeTruthy();
    pageState.persistenceBlocked = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("login without reload")).toBeTruthy();
    expect(document.documentElement.dataset.getStartedDocument).toBe(
      "survived",
    );
    expect(storePendingOnboardingSession).toHaveBeenCalledTimes(2);
  });

  it("retries a failed preview without silently confirming the identity link", async () => {
    vi.mocked(previewPendingOnboardingContinuation).mockRejectedValueOnce(
      new Error("preview temporarily unavailable"),
    );
    const entry = `/get-started?onboardingSession=${TOKEN}`;
    window.history.replaceState(null, "", entry);

    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/get-started" element={<GetStartedPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("preview temporarily unavailable"),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    expect(completePendingOnboardingContinuation).not.toHaveBeenCalled();
    expect(previewPendingOnboardingContinuation).toHaveBeenCalledTimes(2);
  });

  it("renders the Telegram identity preview and confirm for a telegram continuation", async () => {
    vi.mocked(previewPendingOnboardingContinuation).mockResolvedValue({
      platform: "telegram",
      platformUserId: "123456789",
      platformDisplayName: "attested-telegram-user",
      returnUrl: null,
    });
    const entry = `/get-started?onboardingSession=${TOKEN}`;
    window.history.replaceState(null, "", entry);

    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/get-started" element={<GetStartedPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("attested-telegram-user")).toBeTruthy();
    expect(screen.getByText(/Connect your/)).toBeTruthy();
    expect(screen.queryByText(/Discord/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Telegram account/ }),
    );
    expect(await screen.findByText("You're connected")).toBeTruthy();
  });

  it("gates the Telegram account claim behind the explicit confirmation", async () => {
    vi.mocked(previewPendingOnboardingContinuation).mockResolvedValue({
      platform: "telegram",
      platformUserId: "123456789",
      platformDisplayName: "attested-telegram-user",
      returnUrl: null,
    });
    const entry = `/get-started?onboardingSession=${TOKEN}&accountClaim=telegram`;
    window.history.replaceState(null, "", entry);

    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/get-started" element={<GetStartedPage />} />
          <Route path="/join" element={<div>join</div>} />
        </Routes>
      </MemoryRouter>,
    );

    // Load runs the read-only preview only: the identity being linked is
    // named, and no claim fires without a gesture.
    expect(await screen.findByText("attested-telegram-user")).toBeTruthy();
    expect(screen.getByText(/Telegram ID/)).toBeTruthy();
    expect(screen.getByText(/123456789/)).toBeTruthy();
    expect(confirmTelegramAccountClaim).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Telegram account/ }),
    );
    expect(await screen.findByText("join")).toBeTruthy();
    expect(confirmTelegramAccountClaim).toHaveBeenCalledWith(
      "existing-steward-token",
      TOKEN,
    );
    expect(
      peekPendingOnboardingSession(TELEGRAM_ACCOUNT_CLAIM_PURPOSE),
    ).toBeNull();
    expect(window.location.search).not.toContain("accountClaim");
  });

  it("retries a failed Telegram claim without re-running the preview", async () => {
    vi.mocked(previewPendingOnboardingContinuation).mockResolvedValue({
      platform: "telegram",
      platformUserId: "123456789",
      platformDisplayName: "attested-telegram-user",
      returnUrl: null,
    });
    confirmTelegramAccountClaim.mockRejectedValueOnce(
      new Error("claim temporarily unavailable"),
    );
    const entry = `/get-started?onboardingSession=${TOKEN}&accountClaim=telegram`;
    window.history.replaceState(null, "", entry);

    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/get-started" element={<GetStartedPage />} />
          <Route path="/join" element={<div>join</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /Connect this Telegram account/,
      }),
    );
    expect(
      await screen.findByText("claim temporarily unavailable"),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("join")).toBeTruthy();
    expect(confirmTelegramAccountClaim).toHaveBeenCalledTimes(2);
    expect(previewPendingOnboardingContinuation).toHaveBeenCalledTimes(1);
  });

  it("retries a failed Telegram claim preview without ever firing the claim", async () => {
    vi.mocked(previewPendingOnboardingContinuation)
      .mockRejectedValueOnce(new Error("preview temporarily unavailable"))
      .mockResolvedValue({
        platform: "telegram",
        platformUserId: "123456789",
        platformDisplayName: "attested-telegram-user",
        returnUrl: null,
      });
    const entry = `/get-started?onboardingSession=${TOKEN}&accountClaim=telegram`;
    window.history.replaceState(null, "", entry);

    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/get-started" element={<GetStartedPage />} />
          <Route path="/join" element={<div>join</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("preview temporarily unavailable"),
    ).toBeTruthy();
    expect(confirmTelegramAccountClaim).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Try again"));

    fireEvent.click(
      await screen.findByRole("button", {
        name: /Connect this Telegram account/,
      }),
    );
    expect(await screen.findByText("join")).toBeTruthy();
    expect(previewPendingOnboardingContinuation).toHaveBeenCalledTimes(2);
    expect(confirmTelegramAccountClaim).toHaveBeenCalledTimes(1);
    expect(confirmTelegramAccountClaim).toHaveBeenCalledWith(
      "existing-steward-token",
      TOKEN,
    );
  });

  it("offers a deep link back to the originating iMessage conversation", async () => {
    vi.mocked(previewPendingOnboardingContinuation).mockResolvedValue({
      platform: "blooio",
      platformUserId: "+14155550123",
      platformDisplayName: "Shaw",
      returnUrl: "sms:+18087881821",
    });
    const entry = `/get-started?onboardingSession=${TOKEN}`;
    window.history.replaceState(null, "", entry);

    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/get-started" element={<GetStartedPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Shaw")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this iMessage account/ }),
    );
    expect(await screen.findByText("You're connected")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Back to iMessage" })
        .getAttribute("href"),
    ).toBe("sms:+18087881821");
  });

  it("suppresses the return link when the server sends a non-http(s)/sms URL", async () => {
    vi.mocked(previewPendingOnboardingContinuation).mockResolvedValue({
      platform: "discord",
      platformUserId: "1234567890",
      platformDisplayName: "attested-discord-user",
      returnUrl: "javascript:alert(1)",
    });
    const entry = `/get-started?onboardingSession=${TOKEN}`;
    window.history.replaceState(null, "", entry);

    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/get-started" element={<GetStartedPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("attested-discord-user")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Connect this Discord account/ }),
    );
    expect(await screen.findByText("You're connected")).toBeTruthy();
    // The unsafe wire URL must never reach an href — no back link renders.
    expect(screen.queryByRole("link", { name: /Back to Discord/ })).toBeNull();
    // The in-app fallback remains available instead.
    expect(
      screen.getByRole("button", { name: "Or chat here instead" }),
    ).toBeTruthy();
  });
});
