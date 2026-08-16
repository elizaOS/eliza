/**
 * Verifies the affiliates page copy-link controls in jsdom with network and
 * clipboard boundaries mocked; the shipped card layout and component run.
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

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key,
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
  apiMock.mockResolvedValue(affiliatePayload);
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
});

afterEach(() => cleanup());

describe("AffiliatesPageClient copy links", () => {
  it("wraps both URLs and gives each visible copy control a precise name", async () => {
    renderPage();

    const inviteCopy = await screen.findByRole("button", {
      name: "Copy link (invite)",
    });
    const affiliateCopy = screen.getByRole("button", {
      name: "Copy link (affiliate)",
    });
    expect(inviteCopy.textContent).toContain("Copy link");
    expect(affiliateCopy.textContent).toContain("Copy link");

    const inviteUrl = screen.getByText(
      `${window.location.origin}/login?ref=FRIEND1`,
    );
    const affiliateUrl = screen.getByText(
      `${window.location.origin}/login?affiliate=AFFCODE`,
    );
    for (const url of [inviteUrl, affiliateUrl]) {
      expect(url.className).toContain("break-all");
      expect(url.className).not.toContain("whitespace-nowrap");
      expect(url.className).not.toContain("text-ellipsis");
    }
  });

  it("copies the invite URL and announces the icon-plus-text copied state", async () => {
    renderPage();
    const button = await screen.findByRole("button", {
      name: "Copy link (invite)",
    });

    fireEvent.click(button);

    await waitFor(() => {
      expect(copyMock).toHaveBeenCalledWith(
        `${window.location.origin}/login?ref=FRIEND1`,
      );
    });
    expect(
      screen.getByRole("button", { name: "Copied invite link" }).textContent,
    ).toContain("Copied");
    expect(screen.getByRole("status").textContent).toBe("Invite link copied");
    expect(toastMock.success).toHaveBeenCalledWith("Invite link copied");
  });

  it("copies the affiliate URL and announces which link changed", async () => {
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy link (affiliate)" }),
    );

    await waitFor(() => {
      expect(copyMock).toHaveBeenCalledWith(
        `${window.location.origin}/login?affiliate=AFFCODE`,
      );
    });
    expect(
      screen.getByRole("button", { name: "Copied affiliate link" }).textContent,
    ).toContain("Copied");
    expect(screen.getByRole("status").textContent).toBe(
      "Affiliate link copied",
    );
  });

  it("keeps the copy control actionable and reports clipboard failure", async () => {
    copyMock.mockResolvedValueOnce(false);
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy link (invite)" }),
    );

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "Could not copy to clipboard",
      );
    });
    expect(
      screen.getByRole("button", { name: "Copy link (invite)" }).textContent,
    ).toContain("Copy link");
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("does not expose an invite copy control for an inactive code", async () => {
    referralState.referralMe = {
      code: "FRIEND1",
      total_referrals: 0,
      is_active: false,
    };
    renderPage();

    expect(await screen.findByText("Invite link inactive")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Copy link (invite)" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Copy link (affiliate)" }),
    ).toBeTruthy();
  });
});
