/**
 * Exercises AutoTopUpCard loading, DTO validation, retry, stale-result,
 * unmount, and save boundaries in deterministic jsdom with a mocked client.
 */
// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("../../lib/api-client", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: toastMocks,
}));

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? key,
}));

import { AutoTopUpCard } from "./auto-top-up-card";

interface BillingSettingsPayload {
  settings: {
    autoTopUp: {
      enabled: boolean;
      amount: number;
      threshold: number;
      hasPaymentMethod: boolean;
    };
    limits: {
      minAmount: number;
      maxAmount: number;
      minThreshold: number;
      maxThreshold: number;
    };
  };
}

const loadedSettings: BillingSettingsPayload = {
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

function settings(
  autoTopUp:
    | Partial<BillingSettingsPayload["settings"]["autoTopUp"]>
    | boolean = {},
): BillingSettingsPayload {
  const overrides =
    typeof autoTopUp === "boolean" ? { enabled: autoTopUp } : autoTopUp;
  return {
    settings: {
      autoTopUp: { ...loadedSettings.settings.autoTopUp, ...overrides },
      limits: { ...loadedSettings.settings.limits },
    },
  };
}

function savedSettings(
  autoTopUp:
    | Partial<BillingSettingsPayload["settings"]["autoTopUp"]>
    | boolean = {},
) {
  return { settings: { autoTopUp: settings(autoTopUp).settings.autoTopUp } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function isChecked(toggle: HTMLElement): boolean {
  const value =
    toggle.getAttribute("data-state") ?? toggle.getAttribute("aria-checked");
  return value === "checked" || value === "true";
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  apiMock.mockReset();
  toastMocks.success.mockReset();
  toastMocks.error.mockReset();
});

describe("AutoTopUpCard", () => {
  it("announces initial loading without rendering an editor or Save", async () => {
    const loadRequest = deferred<BillingSettingsPayload>();
    apiMock.mockImplementationOnce(() => loadRequest.promise);

    render(<AutoTopUpCard />);

    const status = screen.getByRole("status", {
      name: "Loading auto top-up settings",
    });
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(screen.queryByRole("switch")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Save auto top-up" }),
    ).toBeNull();

    await act(async () => {
      loadRequest.resolve(settings(false));
      await loadRequest.promise;
    });
    expect(await screen.findByRole("switch")).toBeTruthy();
  });

  it("renders a generic alert and 44px Retry action when loading rejects", async () => {
    apiMock.mockRejectedValueOnce(new Error("private backend detail"));

    render(<AutoTopUpCard />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load auto top-up settings");
    expect(alert.textContent).toContain("Check your connection and retry");
    expect(alert.textContent).not.toContain("private backend detail");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Save auto top-up" }),
    ).toBeNull();

    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveProperty("disabled", false);
    expect(retry.getAttribute("aria-busy")).toBe("false");
    expect(retry.getAttribute("type")).toBe("button");
    expect(retry.className).toContain("min-h-touch");

    const baseStyles = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../styles/base.css"),
      "utf8",
    );
    const touchTargetRem = Number(
      baseStyles.match(/--min-touch-target:\s*([\d.]+)rem/)?.[1],
    );
    expect(touchTargetRem * 16).toBe(44);
  });

  it.each([
    ["missing settings", {}],
    [
      "missing autoTopUp",
      { settings: { limits: loadedSettings.settings.limits } },
    ],
    [
      "wrong enabled type",
      settings({ enabled: "false" as unknown as boolean }),
    ],
    [
      "missing hasPaymentMethod",
      {
        settings: {
          ...loadedSettings.settings,
          autoTopUp: { enabled: false, amount: 25, threshold: 10 },
        },
      },
    ],
    ["non-finite amount", settings({ amount: Number.POSITIVE_INFINITY })],
    [
      "missing limit",
      {
        settings: {
          autoTopUp: loadedSettings.settings.autoTopUp,
          limits: { minAmount: 5, maxAmount: 500, minThreshold: 1 },
        },
      },
    ],
    [
      "non-finite limit",
      {
        settings: {
          autoTopUp: loadedSettings.settings.autoTopUp,
          limits: {
            ...loadedSettings.settings.limits,
            maxThreshold: Number.NaN,
          },
        },
      },
    ],
    [
      "inverted limits",
      {
        settings: {
          autoTopUp: loadedSettings.settings.autoTopUp,
          limits: {
            ...loadedSettings.settings.limits,
            minAmount: 501,
          },
        },
      },
    ],
  ])("fails closed for a malformed payload: %s", async (_name, payload) => {
    apiMock.mockResolvedValueOnce(payload);

    render(<AutoTopUpCard />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Save auto top-up" }),
    ).toBeNull();
  });

  it("keeps one Retry alert busy and disabled, then restores backend false", async () => {
    const retryRequest = deferred<BillingSettingsPayload>();
    apiMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => retryRequest.promise);

    render(<AutoTopUpCard />);
    const alert = await screen.findByRole("alert");
    const retry = screen.getByRole("button", { name: "Retry" });

    act(() => {
      retry.click();
      retry.click();
    });

    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toBe(alert);
    expect(retry).toHaveProperty("disabled", true);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("switch")).toBeNull();

    await act(async () => {
      retryRequest.resolve(settings(false));
      await retryRequest.promise;
    });

    const toggle = await screen.findByRole("switch");
    expect(isChecked(toggle)).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("loads backend false and the complete numeric editor", async () => {
    apiMock.mockResolvedValueOnce(settings(false));

    render(<AutoTopUpCard />);

    expect(await screen.findByText("Auto top-up (card)")).toBeTruthy();
    expect(screen.getByText("Enable card auto top-up")).toBeTruthy();
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("id")).toBe("cloud-billing-auto-top-up");
    expect(isChecked(toggle)).toBe(false);
    expect(apiMock).toHaveBeenCalledWith("/api/v1/billing/settings");
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

  it("ignores a stale load failure after its StrictMode replacement succeeds", async () => {
    const staleRequest = deferred<BillingSettingsPayload>();
    const activeRequest = deferred<BillingSettingsPayload>();
    apiMock
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => activeRequest.promise);

    render(
      <StrictMode>
        <AutoTopUpCard />
      </StrictMode>,
    );
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      activeRequest.resolve(settings(false));
      await activeRequest.promise;
    });
    const toggle = await screen.findByRole("switch");
    expect(isChecked(toggle)).toBe(false);

    await act(async () => {
      staleRequest.reject(new Error("late initial failure"));
      await expect(staleRequest.promise).rejects.toThrow(
        "late initial failure",
      );
    });
    expect(isChecked(toggle)).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores a load result delivered after unmount", async () => {
    const loadRequest = deferred<BillingSettingsPayload>();
    apiMock.mockImplementationOnce(() => loadRequest.promise);
    const view = render(<AutoTopUpCard />);

    expect(
      screen.getByRole("status", { name: "Loading auto top-up settings" }),
    ).toBeTruthy();
    view.unmount();

    await act(async () => {
      loadRequest.resolve(settings(true));
      await loadRequest.promise;
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("focuses the amount field when the enabled draft is below its limit", async () => {
    apiMock.mockResolvedValueOnce(settings(false));

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
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the toggle as draft until Save PUTs the autoTopUp payload", async () => {
    apiMock
      .mockResolvedValueOnce(settings(false))
      .mockResolvedValueOnce(savedSettings({ enabled: true }));

    render(<AutoTopUpCard />);
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);

    expect(apiMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save auto top-up" }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenLastCalledWith("/api/v1/billing/settings", {
        method: "PUT",
        json: {
          autoTopUp: { enabled: true, amount: 25, threshold: 10 },
        },
      });
    });
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledTimes(1));
  });

  it("disables editing and Save when no payment method is saved", async () => {
    apiMock.mockResolvedValueOnce(settings({ hasPaymentMethod: false }));

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

  it("keeps the Save label and exposes busy state while persisting", async () => {
    const saveRequest = deferred<ReturnType<typeof savedSettings>>();
    apiMock
      .mockResolvedValueOnce(settings(false))
      .mockImplementationOnce(() => saveRequest.promise);

    render(<AutoTopUpCard />);
    const save = await screen.findByRole("button", {
      name: "Save auto top-up",
    });
    fireEvent.click(save);

    await waitFor(() => {
      expect(save.getAttribute("aria-busy")).toBe("true");
    });
    expect(save).toHaveProperty("disabled", true);
    expect(save.textContent).toMatch(/Save auto top-up/);
    expect(save.textContent).not.toMatch(/Saving/);

    await act(async () => {
      saveRequest.resolve(savedSettings(false));
      await saveRequest.promise;
    });
    await waitFor(() => {
      expect(save.getAttribute("aria-busy")).toBe("false");
    });
  });

  it("suppresses a reentrant Save before React commits the busy state", async () => {
    const saveRequest = deferred<ReturnType<typeof savedSettings>>();
    let putCalls = 0;
    apiMock.mockImplementation(
      (_url: string, options?: { method?: string }) => {
        if (options?.method !== "PUT") return Promise.resolve(settings(false));
        putCalls += 1;
        return putCalls === 1
          ? saveRequest.promise
          : Promise.reject(new Error("duplicate Save must not run"));
      },
    );

    render(<AutoTopUpCard />);
    const save = await screen.findByRole("button", {
      name: "Save auto top-up",
    });

    act(() => {
      save.click();
      save.click();
    });

    expect(putCalls).toBe(1);
    expect(apiMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      saveRequest.resolve(savedSettings(false));
      await saveRequest.promise;
    });
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("preserves a failed-save draft and lets the same draft retry", async () => {
    const firstSave = deferred<ReturnType<typeof savedSettings>>();
    apiMock
      .mockResolvedValueOnce(settings(false))
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce(
        savedSettings({ enabled: true, amount: 30, threshold: 12 }),
      );

    render(<AutoTopUpCard />);
    fireEvent.click(await screen.findByRole("switch"));
    const amount = screen.getByTestId("cloud-billing-auto-top-up-amount");
    const threshold = screen.getByTestId("cloud-billing-auto-top-up-threshold");
    fireEvent.change(amount, { target: { value: "30" } });
    fireEvent.change(threshold, { target: { value: "12" } });
    const save = screen.getByRole("button", { name: "Save auto top-up" });
    fireEvent.click(save);

    await act(async () => {
      firstSave.reject(new Error("transport down"));
      await expect(firstSave.promise).rejects.toThrow("transport down");
    });

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledTimes(1));
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(amount).toHaveProperty("value", "30");
    expect(threshold).toHaveProperty("value", "12");
    expect(save).toHaveProperty("disabled", false);

    fireEvent.click(save);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(3));
    expect(apiMock).toHaveBeenLastCalledWith("/api/v1/billing/settings", {
      method: "PUT",
      json: {
        autoTopUp: { enabled: true, amount: 30, threshold: 12 },
      },
    });
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledTimes(1));
  });

  it("ignores a save rejection delivered after unmount", async () => {
    const saveRequest = deferred<ReturnType<typeof savedSettings>>();
    apiMock
      .mockResolvedValueOnce(settings(false))
      .mockImplementationOnce(() => saveRequest.promise);
    const view = render(<AutoTopUpCard />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Save auto top-up" }),
    );
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    view.unmount();

    await act(async () => {
      saveRequest.reject(new Error("late save failure"));
      await expect(saveRequest.promise).rejects.toThrow("late save failure");
    });
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });
});
