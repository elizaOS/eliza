/** Verifies AuthSuccessPage through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * AuthSuccessPage only claims success after a backend connection lookup.
 * Forged known-provider markers stay unverified. Harness mocks the cloud API
 * client and router/i18n doubles.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const searchParamsRef = vi.hoisted(() => ({
  current: new URLSearchParams(
    "github_connected=true&platform=github&connection_id=conn-1",
  ),
}));

const navigateMock = vi.hoisted(() => vi.fn());
const apiMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
  useNavigate: () => navigateMock,
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT:
    () => (_key: string, opts?: { defaultValue?: string; platform?: string }) =>
      (opts?.defaultValue ?? _key).replace(
        "{{platform}}",
        opts?.platform ?? "",
      ),
}));

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

vi.mock("../../../lib/api-client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.name = "ApiError";
    }
  },
}));

vi.mock("../../../../components/primitives", () => ({
  Button: ({
    children,
    onClick,
    asChild,
    ...rest
  }: {
    children: ReactNode;
    onClick?: () => void;
    asChild?: boolean;
  }) => {
    if (asChild) {
      return <div {...rest}>{children}</div>;
    }
    return (
      <button type="button" onClick={onClick} {...rest}>
        {children}
      </button>
    );
  },
}));

import { ApiError } from "../../../lib/api-client";
import AuthSuccessPage, {
  resolveAuthSuccessCandidate,
  verifyAuthSuccessConnection,
} from "./auth-success-page";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  navigateMock.mockReset();
  apiMock.mockReset();
  searchParamsRef.current = new URLSearchParams(
    "github_connected=true&platform=github&connection_id=conn-1",
  );
  delete (window as { opener?: unknown }).opener;
});

describe("resolveAuthSuccessCandidate", () => {
  it("rejects a naked URL with no params", () => {
    expect(resolveAuthSuccessCandidate(new URLSearchParams())).toEqual({
      kind: "unverified",
      reason: "missing",
    });
  });

  it("rejects a forged known-provider marker without connection_id", () => {
    expect(
      resolveAuthSuccessCandidate(
        new URLSearchParams("github_connected=true&platform=github"),
      ),
    ).toEqual({ kind: "unverified", reason: "untrusted" });
  });

  it("rejects known platform without connection_id", () => {
    expect(
      resolveAuthSuccessCandidate(new URLSearchParams("platform=google")),
    ).toEqual({ kind: "unverified", reason: "untrusted" });
  });

  it("accepts a verification candidate with connection_id + known platform", () => {
    expect(
      resolveAuthSuccessCandidate(
        new URLSearchParams(
          "github_connected=true&platform=github&connection_id=conn-1",
        ),
      ),
    ).toEqual({
      kind: "candidate",
      platform: "github",
      platformDisplay: "GitHub",
      connectionId: "conn-1",
    });
  });

  it("rejects Object.prototype property names as forged platforms", () => {
    expect(
      resolveAuthSuccessCandidate(
        new URLSearchParams("platform=constructor&connection_id=x"),
      ),
    ).toEqual({ kind: "unverified", reason: "untrusted" });
  });
});

describe("verifyAuthSuccessConnection", () => {
  it("accepts only a backend-owned matching active connection", async () => {
    apiMock.mockResolvedValueOnce({
      connection: {
        id: "conn-1",
        platform: "github",
        status: "active",
      },
    });
    await expect(
      verifyAuthSuccessConnection({
        platform: "github",
        connectionId: "conn-1",
      }),
    ).resolves.toEqual({
      ok: true,
      platform: "github",
      platformDisplay: "GitHub",
      connectionId: "conn-1",
    });
  });

  it("rejects a forged connection_id the backend does not own", async () => {
    apiMock.mockRejectedValueOnce(
      new ApiError(404, "not_found", "Connection not found"),
    );
    await expect(
      verifyAuthSuccessConnection({
        platform: "github",
        connectionId: "forged",
      }),
    ).resolves.toEqual({ ok: false, reason: "rejected" });
  });
});

describe("AuthSuccessPage", () => {
  it("renders unverified recovery UI for a naked anonymous URL", async () => {
    searchParamsRef.current = new URLSearchParams();
    render(<AuthSuccessPage />);
    expect(
      await screen.findByText("Connection Could Not Be Verified"),
    ).toBeTruthy();
    expect(screen.getByText("Back to Sign In")).toBeTruthy();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("does not trust a forged known-provider query marker", async () => {
    searchParamsRef.current = new URLSearchParams(
      "github_connected=true&platform=github",
    );
    render(<AuthSuccessPage />);
    expect(
      await screen.findByText("Connection Could Not Be Verified"),
    ).toBeTruthy();
    expect(screen.queryByText("GitHub Connected")).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("shows verified success only after backend confirmation", async () => {
    apiMock.mockResolvedValueOnce({
      connection: { id: "conn-1", platform: "github", status: "active" },
    });
    searchParamsRef.current = new URLSearchParams(
      "github_connected=true&platform=github&connection_id=conn-1",
    );
    render(<AuthSuccessPage />);
    expect(await screen.findByText("GitHub Connected")).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/oauth/connections/conn-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("stays unverified when backend rejects the connection_id", async () => {
    apiMock.mockRejectedValueOnce(
      new ApiError(404, "not_found", "Connection not found"),
    );
    searchParamsRef.current = new URLSearchParams(
      "platform=google&connection_id=audit-fixture",
    );
    render(<AuthSuccessPage />);
    expect(
      await screen.findByText("Connection Could Not Be Verified"),
    ).toBeTruthy();
    expect(screen.queryByText("Google Connected")).toBeNull();
  });

  it("auto-closes only when verified success has a live opener", async () => {
    apiMock.mockResolvedValueOnce({
      connection: { id: "conn-1", platform: "github", status: "active" },
    });
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    Object.defineProperty(window, "opener", {
      value: { closed: false },
      configurable: true,
    });
    vi.useFakeTimers();
    render(<AuthSuccessPage />);
    // Flush the verification promise → verified render, then the 2s auto-close.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("GitHub Connected")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
