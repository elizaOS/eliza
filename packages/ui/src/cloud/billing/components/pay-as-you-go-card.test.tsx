/**
 * Exercises PayAsYouGoCard loading, retry, stale-result, unmount, and
 * optimistic-save boundaries in deterministic jsdom with a mocked HTTP client.
 */
// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
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
}));

vi.mock("sonner", () => ({
  toast: toastMocks,
}));

import { PayAsYouGoCard } from "./pay-as-you-go-card";

interface BillingSettingsPayload {
  settings: { payAsYouGoFromEarnings: boolean };
}

function settings(payAsYouGoFromEarnings: boolean): BillingSettingsPayload {
  return { settings: { payAsYouGoFromEarnings } };
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

describe("PayAsYouGoCard", () => {
  it("announces initial loading without rendering a switch", async () => {
    const loadRequest = deferred<BillingSettingsPayload>();
    apiMock.mockImplementationOnce(() => loadRequest.promise);

    render(<PayAsYouGoCard />);

    const status = screen.getByRole("status", {
      name: "Loading pay-as-you-go setting",
    });
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(screen.queryByRole("switch")).toBeNull();

    await act(async () => {
      loadRequest.resolve(settings(true));
      await loadRequest.promise;
    });
    expect(await screen.findByRole("switch")).toBeTruthy();
  });

  it("renders a generic alert and 44px retry action when loading rejects", async () => {
    apiMock.mockRejectedValueOnce(new Error("private backend detail"));

    render(<PayAsYouGoCard />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load this billing setting");
    expect(alert.textContent).toContain("Check your connection and retry");
    expect(alert.textContent).not.toContain("private backend detail");
    expect(screen.queryByRole("switch")).toBeNull();

    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveProperty("disabled", false);
    expect(retry.getAttribute("aria-busy")).toBe("false");
    expect(retry.getAttribute("type")).toBe("button");
    expect(retry.className).toContain("min-h-touch");

    const baseStyles = readFileSync(
      join(process.cwd(), "src/styles/base.css"),
      "utf8",
    );
    const touchTargetRem = Number(
      baseStyles.match(/--min-touch-target:\s*([\d.]+)rem/)?.[1],
    );
    expect(touchTargetRem * 16).toBe(44);
  });

  it("keeps one retry alert busy and disabled, then restores backend false", async () => {
    const retryRequest = deferred<BillingSettingsPayload>();
    apiMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => retryRequest.promise);

    render(<PayAsYouGoCard />);
    const alert = await screen.findByRole("alert");
    const retry = screen.getByRole("button", { name: "Retry" });

    fireEvent.click(retry);
    fireEvent.click(retry);

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

  it("preserves an initial backend false value instead of applying the default", async () => {
    apiMock.mockResolvedValueOnce(settings(false));

    render(<PayAsYouGoCard />);

    const toggle = await screen.findByRole("switch");
    expect(isChecked(toggle)).toBe(false);
    expect(apiMock).toHaveBeenCalledWith("/api/v1/billing/settings");
  });

  it("fails closed when the response omits the boolean setting", async () => {
    apiMock.mockResolvedValueOnce({ settings: {} });

    render(<PayAsYouGoCard />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("ignores a stale load failure after its replacement succeeds", async () => {
    const staleRequest = deferred<BillingSettingsPayload>();
    const activeRequest = deferred<BillingSettingsPayload>();
    apiMock
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => activeRequest.promise);

    render(
      <StrictMode>
        <PayAsYouGoCard />
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
    const view = render(<PayAsYouGoCard />);

    expect(
      screen.getByRole("status", { name: "Loading pay-as-you-go setting" }),
    ).toBeTruthy();
    view.unmount();

    await act(async () => {
      loadRequest.resolve(settings(true));
      await loadRequest.promise;
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("PUTs the next value when the switch is toggled", async () => {
    apiMock.mockResolvedValueOnce(settings(true)).mockResolvedValueOnce({});

    render(<PayAsYouGoCard />);
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(apiMock).toHaveBeenLastCalledWith("/api/v1/billing/settings", {
        method: "PUT",
        json: { payAsYouGoFromEarnings: false },
      });
    });
    await waitFor(() => expect(isChecked(toggle)).toBe(false));
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
  });

  it("suppresses a reentrant save before React commits the busy state", async () => {
    const firstSave = deferred<unknown>();
    let saveCalls = 0;
    apiMock.mockImplementation((_, options?: { method?: string }) => {
      if (options?.method !== "PUT") return Promise.resolve(settings(false));
      saveCalls += 1;
      return saveCalls === 1
        ? firstSave.promise
        : Promise.reject(new Error("second save must not run"));
    });

    render(<PayAsYouGoCard />);
    const toggle = await screen.findByRole("switch");
    expect(isChecked(toggle)).toBe(false);

    act(() => {
      toggle.click();
      toggle.click();
    });

    expect(saveCalls).toBe(1);
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(isChecked(toggle)).toBe(true);

    await act(async () => {
      firstSave.resolve({});
      await firstSave.promise;
    });

    expect(isChecked(toggle)).toBe(true);
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("rolls a failed save back to the confirmed false value", async () => {
    const saveRequest = deferred<unknown>();
    apiMock
      .mockResolvedValueOnce(settings(false))
      .mockImplementationOnce(() => saveRequest.promise);

    render(<PayAsYouGoCard />);
    const toggle = await screen.findByRole("switch");
    expect(isChecked(toggle)).toBe(false);

    fireEvent.click(toggle);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(isChecked(toggle)).toBe(true);
    expect(toggle).toHaveProperty("disabled", true);

    await act(async () => {
      saveRequest.reject(new Error("private save detail"));
      await expect(saveRequest.promise).rejects.toThrow("private save detail");
    });

    await waitFor(() => expect(isChecked(toggle)).toBe(false));
    expect(toggle).toHaveProperty("disabled", false);
    expect(toastMocks.error).toHaveBeenCalledWith(
      "We couldn't save this billing setting. Your previous setting was restored.",
    );
    expect(toastMocks.success).not.toHaveBeenCalled();
  });
});
