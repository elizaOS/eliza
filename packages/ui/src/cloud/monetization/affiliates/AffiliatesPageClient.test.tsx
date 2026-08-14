/**
 * Renders AffiliatesPageClient copyable invite/affiliate URLs through
 * SettingsRow + copy control. jsdom, mocked affiliates and referral APIs.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const copyMock = vi.hoisted(() => vi.fn(async () => true));
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
const referralState = vi.hoisted(() => ({
  referralMe: {
    code: "FRIEND1",
    total_referrals: 2,
    is_active: true,
  },
  loadingReferral: false,
  referralFetchFailed: false,
  refetch: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? key,
}));

vi.mock("../lib/clipboard", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/clipboard")>(
      "../lib/clipboard",
    );
  return {
    ...actual,
    copyTextToClipboard: copyMock,
  };
});

vi.mock("./use-dashboard-referral-me", () => ({
  useDashboardReferralMe: () => referralState,
}));

import { AffiliatesPageClient } from "./AffiliatesPageClient";

const affiliatePayload = {
  code: {
    id: "aff-1",
    code: "AFFCODE",
    markup_percent: "20.00",
    is_active: true,
  },
};

function renderPage() {
  return render(
    <MemoryRouter>
      <AffiliatesPageClient />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMock.mockReset();
  copyMock.mockReset();
  copyMock.mockResolvedValue(true);
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  referralState.referralMe = {
    code: "FRIEND1",
    total_referrals: 2,
    is_active: true,
  };
  referralState.loadingReferral = false;
  referralState.referralFetchFailed = false;
  apiMock.mockResolvedValue(affiliatePayload);
  vi.stubGlobal("location", {
    ...window.location,
    origin: "https://app.eliza.test",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AffiliatesPageClient copy rows", () => {
  it("routes invite and affiliate URLs through labelled SettingsRows", async () => {
    renderPage();

    expect(await screen.findByText("Invite link")).toBeTruthy();
    expect(screen.getByText("Affiliate link")).toBeTruthy();
    expect(
      screen.getByText("https://app.eliza.test/login?ref=FRIEND1"),
    ).toBeTruthy();
    expect(
      screen.getByText("https://app.eliza.test/login?affiliate=AFFCODE"),
    ).toBeTruthy();

    const inviteCopy = screen.getByTestId("cloud-affiliates-copy-invite");
    const affiliateCopy = screen.getByTestId("cloud-affiliates-copy-affiliate");
    expect(inviteCopy.textContent).toMatch(/Copy link/);
    expect(affiliateCopy.textContent).toMatch(/Copy link/);
    expect(inviteCopy.getAttribute("aria-label")).toBe("Copy link (invite)");
    expect(affiliateCopy.getAttribute("aria-label")).toBe(
      "Copy link (affiliate)",
    );
    expect(screen.getByRole("button", { name: "Copy link (invite)" })).toBe(
      inviteCopy,
    );
    expect(screen.getByRole("button", { name: "Copy link (affiliate)" })).toBe(
      affiliateCopy,
    );

    const inviteUrl = screen.getByText(
      "https://app.eliza.test/login?ref=FRIEND1",
    );
    expect(inviteUrl.className).toMatch(/break-all/);
    expect(inviteUrl.className).not.toMatch(/whitespace-nowrap/);
    expect(screen.getByTestId("cloud-affiliates-markup-percent")).toBeTruthy();
    expect(screen.getByText("cURL Example")).toBeTruthy();
    expect(screen.getByText("Affiliate Program")).toBeTruthy();
  });

  it("copies the invite URL and announces copied with icon plus text", async () => {
    renderPage();
    const inviteCopy = await screen.findByTestId(
      "cloud-affiliates-copy-invite",
    );

    fireEvent.click(inviteCopy);

    await waitFor(() => {
      expect(copyMock).toHaveBeenCalledWith(
        "https://app.eliza.test/login?ref=FRIEND1",
      );
    });
    expect(toastMock.success).toHaveBeenCalledWith("Invite link copied");
    expect(inviteCopy.textContent).toMatch(/Copied/);
    expect(inviteCopy.getAttribute("aria-label")).toBe("Copied invite link");
    expect(screen.getByRole("status").textContent).toBe("Invite link copied");
  });

  it("copies the affiliate URL and keeps the cURL snippet out of the row", async () => {
    renderPage();
    const affiliateCopy = await screen.findByTestId(
      "cloud-affiliates-copy-affiliate",
    );

    fireEvent.click(affiliateCopy);

    await waitFor(() => {
      expect(copyMock).toHaveBeenCalledWith(
        "https://app.eliza.test/login?affiliate=AFFCODE",
      );
    });
    expect(toastMock.success).toHaveBeenCalledWith("Affiliate link copied");
    expect(affiliateCopy.textContent).toMatch(/Copied/);
    expect(screen.getByText("cURL Example")).toBeTruthy();
  });

  it("toasts when the clipboard write fails", async () => {
    copyMock.mockResolvedValueOnce(false);
    renderPage();
    fireEvent.click(await screen.findByTestId("cloud-affiliates-copy-invite"));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "Could not copy to clipboard",
      );
    });
    expect(
      screen.getByRole("button", { name: "Copy link (invite)" }).textContent,
    ).toMatch(/Copy link/);
  });

  it("does not show the invite copy row when the referral code is inactive", async () => {
    referralState.referralMe = {
      code: "FRIEND1",
      total_referrals: 0,
      is_active: false,
    };
    renderPage();

    expect(await screen.findByText("Invite link inactive")).toBeTruthy();
    expect(screen.queryByTestId("cloud-affiliates-copy-invite")).toBeNull();
    expect(screen.getByTestId("cloud-affiliates-copy-affiliate")).toBeTruthy();
  });
});
