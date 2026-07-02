// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// --- collaborator doubles (hoisted so vi.mock factories can close over them) ---
const apiMock = vi.hoisted(() => vi.fn());
const openExternalUrlMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api-client")>(
    "../../lib/api-client",
  );
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});
vi.mock("../../../utils/openExternalUrl", () => ({
  openExternalUrl: (...args: unknown[]) => openExternalUrlMock(...args),
}));
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: vi.fn(),
  },
}));
// t() returns the defaultValue with {{vars}} interpolated so assertions read real copy.
vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT:
    () =>
    (_k: string, o?: Record<string, unknown> & { defaultValue?: string }) => {
      let s = o?.defaultValue ?? _k;
      if (o) {
        for (const [key, val] of Object.entries(o)) {
          if (key !== "defaultValue") {
            s = s.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(val));
          }
        }
      }
      return s;
    },
}));

import { ApiError } from "../../lib/api-client";
import { BuyDomainCard } from "./BuyDomainCard";

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  openExternalUrlMock.mockReset();
  toastSuccessMock.mockReset();
});

async function checkDomain(
  user: ReturnType<typeof userEvent.setup>,
  domain: string,
) {
  await user.type(screen.getByLabelText("Domain to buy"), domain);
  await user.click(screen.getByRole("button", { name: /Check/i }));
}

describe("BuyDomainCard (#10246)", () => {
  const checkBtn = () =>
    screen.getByRole("button", { name: /Check/i }) as HTMLButtonElement;

  it("disables Check until the input looks like a domain", async () => {
    const user = userEvent.setup({ delay: null });
    render(<BuyDomainCard appId="app_1" onPurchased={vi.fn()} />);

    expect(checkBtn().disabled).toBe(true);
    await user.type(screen.getByLabelText("Domain to buy"), "not-a-domain");
    expect(checkBtn().disabled).toBe(true);
    await user.type(screen.getByLabelText("Domain to buy"), ".com");
    expect(checkBtn().disabled).toBe(false);
  });

  it("checks availability and shows the price + renewal quote", async () => {
    apiMock.mockResolvedValueOnce({
      success: true,
      domain: "yourbrand.com",
      available: true,
      currency: "USD",
      price: { totalUsdCents: 1495 },
      renewal: { totalUsdCents: 1599 },
    });
    const user = userEvent.setup({ delay: null });
    render(<BuyDomainCard appId="app_1" onPurchased={vi.fn()} />);

    await checkDomain(user, "yourbrand.com");

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/v1/apps/app_1/domains/check", {
        method: "POST",
        json: { domain: "yourbrand.com" },
      }),
    );
    expect(await screen.findByText(/\$14\.95\/yr/)).toBeTruthy();
    expect(screen.getByText(/renews \$15\.99\/yr/)).toBeTruthy();
  });

  it("shows 'not available' for a taken domain, with no Buy button", async () => {
    apiMock.mockResolvedValueOnce({
      success: true,
      domain: "taken.com",
      available: false,
    });
    const user = userEvent.setup({ delay: null });
    render(<BuyDomainCard appId="app_1" onPurchased={vi.fn()} />);

    await checkDomain(user, "taken.com");

    expect(await screen.findByText(/taken\.com is not available/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Buy \$/ })).toBeNull();
  });

  it("buys after explicit confirm and refreshes the domain list", async () => {
    apiMock
      .mockResolvedValueOnce({
        success: true,
        domain: "yourbrand.com",
        available: true,
        price: { totalUsdCents: 1495 },
        renewal: { totalUsdCents: 1495 },
      })
      .mockResolvedValueOnce({
        success: true,
        domain: "yourbrand.com",
        status: "active",
        pendingZoneProvisioning: false,
      });
    const onPurchased = vi.fn();
    const user = userEvent.setup({ delay: null });
    render(<BuyDomainCard appId="app_1" onPurchased={onPurchased} />);

    await checkDomain(user, "yourbrand.com");
    await user.click(
      await screen.findByRole("button", { name: /Buy \$14\.95/ }),
    );
    // Confirm dialog
    await user.click(
      await screen.findByRole("button", { name: /^Buy domain$/ }),
    );

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/v1/apps/app_1/domains/buy", {
        method: "POST",
        json: { domain: "yourbrand.com" },
      }),
    );
    expect(onPurchased).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("on 402 surfaces an insufficient-credits error and an Add-credits CTA to the system browser", async () => {
    apiMock
      .mockResolvedValueOnce({
        success: true,
        domain: "yourbrand.com",
        available: true,
        price: { totalUsdCents: 1495 },
        renewal: { totalUsdCents: 1495 },
      })
      .mockRejectedValueOnce(
        new ApiError(
          402,
          "insufficient_balance",
          "Insufficient credit balance for this domain",
        ),
      );
    const user = userEvent.setup({ delay: null });
    render(<BuyDomainCard appId="app_1" onPurchased={vi.fn()} />);

    await checkDomain(user, "yourbrand.com");
    await user.click(
      await screen.findByRole("button", { name: /Buy \$14\.95/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: /^Buy domain$/ }),
    );

    expect(
      await screen.findByText(/Insufficient credit balance for this domain/),
    ).toBeTruthy();
    const addCredits = await screen.findByRole("button", {
      name: /Add credits/i,
    });
    await user.click(addCredits);
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      expect.stringContaining("/settings#cloud-billing"),
    );
  });
});
