/**
 * Renders AutoTopUpCard through SettingsSwitchRow and asserts load, draft
 * toggle, save persist, accessible loading, and payment-method warning chrome.
 * jsdom, mocked billing settings API.
 */
// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? key,
}));

import { AutoTopUpCard } from "./auto-top-up-card";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  apiMock.mockReset();
});

const loadedSettings = {
  settings: {
    autoTopUp: {
      enabled: false,
      amount: 25,
      threshold: 10,
      hasPaymentMethod: true,
    },
    limits: {
      minAmount: 5,
      maxAmount: 500,
      minThreshold: 1,
      maxThreshold: 200,
    },
  },
};

describe("AutoTopUpCard", () => {
  it("announces loading with an accessible status name", async () => {
    let resolveSettings: (value: typeof loadedSettings) => void = () => {};
    apiMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve;
        }),
    );

    render(<AutoTopUpCard />);

    const status = screen.getByRole("status", {
      name: /loading auto top-up settings/i,
    });
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );

    resolveSettings(loadedSettings);
    expect(await screen.findByRole("switch")).toBeTruthy();
    expect(
      screen.queryByRole("status", { name: /loading auto top-up settings/i }),
    ).toBeNull();
  });

  it("loads the enable switch as SettingsSwitchRow inside the BrandCard editor", async () => {
    apiMock.mockResolvedValueOnce(loadedSettings);

    render(<AutoTopUpCard />);

    expect(await screen.findByText("Auto top-up (card)")).toBeTruthy();
    expect(screen.getByText("Enable card auto top-up")).toBeTruthy();
    const toggle = await screen.findByRole("switch");
    expect(toggle.getAttribute("id")).toBe("cloud-billing-auto-top-up");
    expect(
      toggle.getAttribute("data-state") ?? toggle.getAttribute("aria-checked"),
    ).toMatch(/unchecked|false/);
    expect(apiMock).toHaveBeenCalledWith("/api/v1/billing/settings");
    expect(screen.getByText("Top-up amount")).toBeTruthy();
    expect(screen.getByText("Trigger threshold")).toBeTruthy();
    expect(
      screen.getByTestId("cloud-billing-auto-top-up-amount"),
    ).toHaveProperty("value", "25");
    expect(
      screen.getByTestId("cloud-billing-auto-top-up-threshold"),
    ).toHaveProperty("value", "10");
    expect(
      screen.getByRole("button", { name: "Save auto top-up" }),
    ).toBeTruthy();
  });

  it("shows the amount error on the amount field when the value is below the limit", async () => {
    apiMock.mockResolvedValueOnce(loadedSettings);

    render(<AutoTopUpCard />);
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);
    fireEvent.change(screen.getByTestId("cloud-billing-auto-top-up-amount"), {
      target: { value: "1" },
    });

    const alert = await screen.findByRole("alert");
    expect(alert.id).toBe("cloud-billing-auto-top-up-amount-error");
    expect(alert.textContent).toMatch(/Enter at least/i);
    const save = screen.getByRole("button", { name: "Save auto top-up" });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    expect(document.activeElement).toBe(
      screen.getByTestId("cloud-billing-auto-top-up-amount"),
    );
  });

  it("keeps the toggle as draft until Save PUTs the autoTopUp payload", async () => {
    apiMock
      .mockResolvedValueOnce(loadedSettings)
      .mockResolvedValueOnce(loadedSettings);

    render(<AutoTopUpCard />);
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);

    expect(apiMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Save auto top-up" }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenLastCalledWith("/api/v1/billing/settings", {
        method: "PUT",
        json: {
          autoTopUp: {
            enabled: true,
            amount: 25,
            threshold: 10,
          },
        },
      });
    });
  });

  it("disables the enable switch when no payment method is saved", async () => {
    apiMock.mockResolvedValueOnce({
      settings: {
        autoTopUp: {
          enabled: false,
          amount: 25,
          threshold: 10,
          hasPaymentMethod: false,
        },
        limits: loadedSettings.settings.limits,
      },
    });

    render(<AutoTopUpCard />);
    const toggle = await screen.findByRole("switch");
    expect(toggle).toHaveProperty("disabled", true);
    const warning = screen.getByRole("status", {
      name: /no saved payment method/i,
    });
    expect(warning.className).toMatch(/border-status-warning/);
    expect(warning.className).toMatch(/bg-status-warning-bg/);
    expect(warning.querySelector("p")?.className).toMatch(
      /text-status-warning/,
    );
    expect(warning.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Save auto top-up" }),
    ).toHaveProperty("disabled", true);
  });

  it("keeps the save label while the persist request is in flight", async () => {
    let resolveSave: (value: typeof loadedSettings) => void = () => {};
    apiMock.mockResolvedValueOnce(loadedSettings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    render(<AutoTopUpCard />);
    const save = await screen.findByRole("button", {
      name: "Save auto top-up",
    });
    fireEvent.click(save);

    await waitFor(() => {
      expect(save.getAttribute("aria-busy")).toBe("true");
    });
    expect(save.textContent).toMatch(/Save auto top-up/);
    expect(save.textContent).not.toMatch(/Saving/);

    resolveSave(loadedSettings);
    await waitFor(() => {
      expect(save.getAttribute("aria-busy")).toBe("false");
    });
  });

  it("stores the card title in natural case and uses status tokens, not raw yellow", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "auto-top-up-card.tsx"),
      "utf8",
    );
    expect(source).toContain('defaultValue: "Auto top-up (card)"');
    expect(source).toContain("uppercase");
    expect(source).toContain("border-status-warning/30");
    expect(source).toContain("bg-status-warning-bg");
    expect(source).toContain("text-status-warning");
    expect(source).not.toMatch(/yellow-\d+/);
    expect(source).toContain('defaultValue: "Save auto top-up"');
  });
});
