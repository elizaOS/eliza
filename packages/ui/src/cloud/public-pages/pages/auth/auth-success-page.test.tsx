/** Verifies AuthSuccessPage through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * `AuthSuccessPage` only claims success from a backend-issued completion
 * signal for a known platform. Naked, arbitrary, or platform-only URLs render
 * an unverified state with keyboard-reachable recovery actions. Auto-close
 * runs only on verified success with a live opener.
 */

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const searchParamsRef = vi.hoisted(() => ({
  current: new URLSearchParams("github_connected=1"),
}));

const navigateMock = vi.hoisted(() => vi.fn());

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

import AuthSuccessPage, { resolveAuthSuccessSignal } from "./auth-success-page";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  navigateMock.mockReset();
  searchParamsRef.current = new URLSearchParams("github_connected=1");
  delete (window as { opener?: unknown }).opener;
});

describe("resolveAuthSuccessSignal", () => {
  it("rejects a naked URL with no params", () => {
    expect(resolveAuthSuccessSignal(new URLSearchParams())).toEqual({
      kind: "unverified",
      reason: "missing",
    });
  });

  it("rejects an arbitrary platform label without a completion marker", () => {
    expect(
      resolveAuthSuccessSignal(new URLSearchParams("platform=EvilBank")),
    ).toEqual({ kind: "unverified", reason: "untrusted" });
  });

  it("rejects a known platform without *_connected or connection_id", () => {
    expect(
      resolveAuthSuccessSignal(new URLSearchParams("platform=google")),
    ).toEqual({ kind: "unverified", reason: "untrusted" });
  });

  it("accepts a known platform *_connected marker", () => {
    expect(
      resolveAuthSuccessSignal(
        new URLSearchParams("github_connected=true&platform=github"),
      ),
    ).toEqual({
      kind: "verified",
      platform: "github",
      platformDisplay: "GitHub",
      connectionId: null,
    });
  });

  it("accepts every generic-callback provider id the registry emits", () => {
    for (const platform of [
      "hubspot",
      "asana",
      "dropbox",
      "salesforce",
      "airtable",
      "zoom",
      "jira",
      "linkedin",
      "twitter",
      "microsoft",
    ] as const) {
      expect(
        resolveAuthSuccessSignal(
          new URLSearchParams(
            `${platform}_connected=true&platform=${platform}&connection_id=conn-1`,
          ),
        ).kind,
      ).toBe("verified");
    }
  });

  it("accepts twitter_connected without a platform query (twitter callback shape)", () => {
    expect(
      resolveAuthSuccessSignal(new URLSearchParams("twitter_connected=true")),
    ).toEqual({
      kind: "verified",
      platform: "twitter",
      platformDisplay: "Twitter",
      connectionId: null,
    });
  });

  it("accepts a backend-issued connection_id with a known platform", () => {
    expect(
      resolveAuthSuccessSignal(
        new URLSearchParams("platform=google&connection_id=conn-123"),
      ),
    ).toEqual({
      kind: "verified",
      platform: "google",
      platformDisplay: "Google",
      connectionId: "conn-123",
    });
  });

  it("rejects connection_id paired with an unknown platform", () => {
    expect(
      resolveAuthSuccessSignal(
        new URLSearchParams("platform=evil&connection_id=conn-123"),
      ),
    ).toEqual({ kind: "unverified", reason: "untrusted" });
  });

  it("rejects Object.prototype property names as forged platforms", () => {
    expect(
      resolveAuthSuccessSignal(
        new URLSearchParams("platform=constructor&connection_id=x"),
      ),
    ).toEqual({ kind: "unverified", reason: "untrusted" });
    expect(
      resolveAuthSuccessSignal(
        new URLSearchParams("constructor_connected=true"),
      ),
    ).toEqual({ kind: "unverified", reason: "untrusted" });
  });
});

describe("AuthSuccessPage", () => {
  it("renders unverified recovery UI for a naked anonymous URL", () => {
    searchParamsRef.current = new URLSearchParams();
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    render(<AuthSuccessPage />);

    expect(screen.getByText("Connection Could Not Be Verified")).toBeTruthy();
    expect(screen.getByText("Back to Sign In")).toBeTruthy();
    expect(screen.getByText("Go Home")).toBeTruthy();
    expect(screen.queryByText("Connection Successful")).toBeNull();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("does not trust an arbitrary platform query param", () => {
    searchParamsRef.current = new URLSearchParams("platform=EvilBank");

    render(<AuthSuccessPage />);

    expect(screen.getByText("Connection Could Not Be Verified")).toBeTruthy();
    expect(screen.queryByText(/EvilBank/i)).toBeNull();
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("shows verified success for a backend-issued github_connected marker", () => {
    searchParamsRef.current = new URLSearchParams(
      "github_connected=true&platform=github&connection_id=conn-1",
    );
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    render(<AuthSuccessPage />);

    expect(closeSpy).not.toHaveBeenCalled();
    expect(screen.getByText("GitHub Connected")).toBeTruthy();
    expect(screen.getByText("Return to the app to continue.")).toBeTruthy();
    expect(screen.getByText("Return to App")).toBeTruthy();
    expect(screen.queryByText("You can close this window.")).toBeNull();
  });

  it("auto-closes only when verified success has a live opener", () => {
    searchParamsRef.current = new URLSearchParams(
      "github_connected=true&platform=github",
    );
    vi.useFakeTimers();
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    Object.defineProperty(window, "opener", {
      value: { closed: false },
      configurable: true,
    });

    render(<AuthSuccessPage />);
    vi.advanceTimersByTime(2000);

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not auto-close an unverified page even with a live opener", () => {
    searchParamsRef.current = new URLSearchParams();
    vi.useFakeTimers();
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    Object.defineProperty(window, "opener", {
      value: { closed: false },
      configurable: true,
    });

    render(<AuthSuccessPage />);
    vi.advanceTimersByTime(2000);

    expect(closeSpy).not.toHaveBeenCalled();
  });
});
