import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  api: vi.fn(),
  emitAuditEvent: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@/lib/api-client", () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    apiFetch: mocks.apiFetch,
    api: mocks.api,
    ApiError,
  };
});

vi.mock("@/lib/security/audit-client", () => ({
  emitAuditEvent: mocks.emitAuditEvent,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    info: mocks.toastInfo,
  },
  Toaster: () => null,
}));

import { PrivacyPanel } from "./privacy-panel";

// The vitest environment may not provide a full localStorage; stub it so
// tests that read/write localStorage don't crash.
const localStorageFallback: Storage = (() => {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
})();

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.api.mockReset();
  mocks.emitAuditEvent.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastInfo.mockReset();
  if (!window.localStorage || typeof window.localStorage.clear !== "function") {
    Object.defineProperty(window, "localStorage", {
      value: localStorageFallback,
      writable: true,
      configurable: true,
    });
  }
  window.localStorage.clear();
});

afterEach(() => cleanup());

describe("PrivacyPanel DSR delete flow", () => {
  test("requires the typed confirmation phrase before calling the API", async () => {
    mocks.apiFetch.mockResolvedValue({} as Response);
    render(<PrivacyPanel />);

    fireEvent.click(screen.getByTestId("delete-account-trigger"));

    const confirmBtn = screen.getByTestId("delete-account-confirm");
    expect(confirmBtn).toBeDisabled();

    const input = screen.getByTestId(
      "delete-account-confirm-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "delete my account" } });

    await waitFor(() => expect(confirmBtn).not.toBeDisabled());
    fireEvent.click(confirmBtn);

    await waitFor(() =>
      expect(mocks.apiFetch).toHaveBeenCalledWith("/api/v1/me/delete-request", {
        method: "POST",
      }),
    );
    expect(mocks.emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "data.delete_request",
        result: "allow",
      }),
    );
  });

  test("toggling vision emits a vision audit event", async () => {
    render(<PrivacyPanel />);
    const toggle = screen.getByTestId("vision-toggle");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mocks.emitAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "vision.allowed", result: "allow" }),
      ),
    );
    expect(
      window.localStorage.getItem("eliza.security.consent.vision.enabled"),
    ).toBe("true");
  });
});
