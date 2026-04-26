// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapExchangeResult } from "../../api/client-agent";
import { BootstrapStep } from "./BootstrapStep";

// Prevent real dynamic imports of "../../api" inside the component.
vi.mock("../../api", () => ({
  client: {
    postBootstrapExchange: vi.fn(),
  },
}));

afterEach(cleanup);

function makeSuccess(
  sessionId = "abc123",
  identityId = "id-456",
  expiresAt = Date.now() + 3600_000,
): BootstrapExchangeResult {
  return { ok: true, sessionId, identityId, expiresAt };
}

function makeFailure(
  status: 400 | 401 | 429 | 503,
  error = "auth_required",
  reason?: string,
): BootstrapExchangeResult {
  return { ok: false, status, error, reason };
}

describe("BootstrapStep", () => {
  let sessionStorageMock: Storage;

  beforeEach(() => {
    // Provide a real sessionStorage substitute.
    const store: Record<string, string> = {};
    sessionStorageMock = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
      key: (i: number) => Object.keys(store)[i] ?? null,
      get length() {
        return Object.keys(store).length;
      },
    };
    Object.defineProperty(globalThis, "sessionStorage", {
      value: sessionStorageMock,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the form with a paste field and submit button", () => {
    render(
      <BootstrapStep
        onAdvance={() => {}}
        exchangeFn={() => Promise.resolve(makeSuccess())}
      />,
    );
    expect(screen.getByRole("form")).toBeTruthy();
    expect(screen.getByRole("button", { name: /activate/i })).toBeTruthy();
    const input = screen.getByPlaceholderText(/paste your bootstrap token/i);
    expect(input).toBeTruthy();
  });

  it("disables submit when token is empty", () => {
    render(
      <BootstrapStep
        onAdvance={() => {}}
        exchangeFn={() => Promise.resolve(makeSuccess())}
      />,
    );
    const button = screen.getByRole("button", {
      name: /activate/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("calls exchange with the typed token and writes session to sessionStorage on success", async () => {
    const onAdvance = vi.fn();
    const exchangeFn = vi.fn(async (_: string) => makeSuccess("sess-abc"));

    render(<BootstrapStep onAdvance={onAdvance} exchangeFn={exchangeFn} />);

    const input = screen.getByPlaceholderText(/paste your bootstrap token/i);
    fireEvent.change(input, { target: { value: "my-token-123" } });
    fireEvent.submit(screen.getByRole("form"));

    await waitFor(() => {
      expect(exchangeFn).toHaveBeenCalledWith("my-token-123");
      expect(sessionStorage.getItem("milady_session")).toBe("sess-abc");
      expect(onAdvance).toHaveBeenCalledOnce();
    });
  });

  it("does not call onAdvance and shows error on 401", async () => {
    const onAdvance = vi.fn();
    const exchangeFn = vi.fn(async () =>
      makeFailure(401, "auth_required", "token_expired"),
    );

    render(<BootstrapStep onAdvance={onAdvance} exchangeFn={exchangeFn} />);

    const input = screen.getByPlaceholderText(/paste your bootstrap token/i);
    fireEvent.change(input, { target: { value: "bad-token" } });
    fireEvent.submit(screen.getByRole("form"));

    await waitFor(() => {
      expect(onAdvance).not.toHaveBeenCalled();
      expect(sessionStorage.getItem("milady_session")).toBeNull();
    });

    // Error message should mention single-use nature.
    // FieldMessage renders with aria-live="assertive" (not role="alert").
    expect(
      screen.getByText(/single-use|already used|must rotate/i),
    ).toBeTruthy();
  });

  it("shows a rate-limit error on 429 and does not advance", async () => {
    const onAdvance = vi.fn();
    const exchangeFn = vi.fn(async () =>
      makeFailure(429, "rate_limited", "rate_limited"),
    );

    render(<BootstrapStep onAdvance={onAdvance} exchangeFn={exchangeFn} />);

    fireEvent.change(
      screen.getByPlaceholderText(/paste your bootstrap token/i),
      { target: { value: "tok" } },
    );
    fireEvent.submit(screen.getByRole("form"));

    await waitFor(() => {
      expect(onAdvance).not.toHaveBeenCalled();
    });

    expect(screen.getByText(/wait a minute/i)).toBeTruthy();
  });

  it("surfaces network errors and does not set session or advance", async () => {
    const onAdvance = vi.fn();
    const exchangeFn = vi.fn(async () => {
      throw new Error("fetch failed");
    });

    render(<BootstrapStep onAdvance={onAdvance} exchangeFn={exchangeFn} />);

    fireEvent.change(
      screen.getByPlaceholderText(/paste your bootstrap token/i),
      { target: { value: "tok" } },
    );
    fireEvent.submit(screen.getByRole("form"));

    await waitFor(() => {
      expect(onAdvance).not.toHaveBeenCalled();
      expect(sessionStorage.getItem("milady_session")).toBeNull();
    });

    expect(screen.getByText(/network error|fetch failed/i)).toBeTruthy();
  });

  it("shows the where-do-I-get-this disclosure", () => {
    render(
      <BootstrapStep
        onAdvance={() => {}}
        exchangeFn={() => Promise.resolve(makeSuccess())}
      />,
    );
    expect(screen.getByText(/where do i get this/i)).toBeTruthy();
  });
});
