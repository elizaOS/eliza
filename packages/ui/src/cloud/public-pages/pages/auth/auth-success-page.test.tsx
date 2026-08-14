/** Verifies AuthSuccessPage through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * AuthSuccessPage only claims success after a one-time session-bound proof
 * consume or an authenticated ownership lookup. Forged markers, forwarded
 * proofs, and replays stay unverified; outages are a distinct unavailable
 * state. Harness mocks the cloud API client.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchParamsRef = vi.hoisted(() => ({
  current: new URLSearchParams(
    "github_connected=true&platform=github&connection_id=conn-1&proof=p.sig",
  ),
}));

const navigateMock = vi.hoisted(() => vi.fn());
const apiMock = vi.hoisted(() => vi.fn());
const bearerTokenRef = vi.hoisted(() => ({ current: null as string | null }));

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
  readCloudBearerToken: () => bearerTokenRef.current,
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
  verifyAuthSuccessCandidate,
} from "./auth-success-page";

function setPageOrigin(origin: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL(`${origin}/auth/success`),
  });
}

beforeEach(() => {
  // Default to a Cloud web origin so relative `api()` transport is exercised.
  // jsdom's default host is loopback, which intentionally uses absolute Cloud.
  setPageOrigin("https://app.elizacloud.ai");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  navigateMock.mockReset();
  apiMock.mockReset();
  bearerTokenRef.current = null;
  searchParamsRef.current = new URLSearchParams(
    "github_connected=true&platform=github&connection_id=conn-1&proof=p.sig",
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

  it("rejects a forged known-provider marker without proof or connection_id", () => {
    expect(
      resolveAuthSuccessCandidate(
        new URLSearchParams("github_connected=true&platform=github"),
      ),
    ).toEqual({ kind: "unverified", reason: "untrusted" });
  });

  it("prefers explicit platform over a stale *_connected marker", () => {
    expect(
      resolveAuthSuccessCandidate(
        new URLSearchParams(
          "google_connected=true&platform=github&connection_id=conn-1&proof=p.sig",
        ),
      ),
    ).toEqual({
      kind: "candidate",
      platform: "github",
      platformDisplay: "GitHub",
      connectionId: "conn-1",
      proof: "p.sig",
    });
  });

  it("accepts a proof-only twitter candidate", () => {
    expect(
      resolveAuthSuccessCandidate(
        new URLSearchParams(
          "twitter_connected=true&platform=twitter&proof=abc.sig",
        ),
      ),
    ).toEqual({
      kind: "candidate",
      platform: "twitter",
      platformDisplay: "Twitter",
      connectionId: null,
      proof: "abc.sig",
    });
  });

  it("accepts a Discord auth/success candidate with platform + proof", () => {
    expect(
      resolveAuthSuccessCandidate(
        new URLSearchParams(
          "discord=connected&platform=discord&discord_connected=true&proof=d.sig",
        ),
      ),
    ).toEqual({
      kind: "candidate",
      platform: "discord",
      platformDisplay: "Discord",
      connectionId: null,
      proof: "d.sig",
    });
  });

  it("rejects legacy Discord marker-only auth/success URLs", () => {
    expect(
      resolveAuthSuccessCandidate(
        new URLSearchParams("discord=connected&guildId=1"),
      ),
    ).toEqual({ kind: "unverified", reason: "missing" });
  });

  it("accepts connection_id + platform as a session-lookup candidate", () => {
    expect(
      resolveAuthSuccessCandidate(
        new URLSearchParams("platform=github&connection_id=conn-1"),
      ),
    ).toEqual({
      kind: "candidate",
      platform: "github",
      platformDisplay: "GitHub",
      connectionId: "conn-1",
      proof: null,
    });
  });
});

describe("verifyAuthSuccessCandidate", () => {
  it("accepts a session-bound proof without a second ownership lookup", async () => {
    apiMock.mockResolvedValueOnce({
      ok: true,
      platform: "github",
      connectionId: "conn-1",
    });
    await expect(
      verifyAuthSuccessCandidate({
        platform: "github",
        connectionId: "conn-1",
        proof: "p.sig",
      }),
    ).resolves.toEqual({
      ok: true,
      platform: "github",
      platformDisplay: "GitHub",
      connectionId: "conn-1",
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/oauth/success-proof/verify?proof=p.sig",
      expect.any(Object),
    );
  });

  it("fails closed on a forwarded proof when the verify endpoint is unauthorized", async () => {
    // Adversarial: anonymous visitor pastes victim's /auth/success?...&proof=…
    apiMock.mockRejectedValueOnce(
      new ApiError(401, "unauthorized", "no session"),
    );
    await expect(
      verifyAuthSuccessCandidate({
        platform: "twitter",
        connectionId: null,
        proof: "forwarded.twitter.sig",
      }),
    ).resolves.toEqual({ ok: false, reason: "rejected" });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a binding mismatch (different session than mint-time org/user)", async () => {
    apiMock.mockRejectedValueOnce(
      new ApiError(403, "forbidden", "binding_mismatch"),
    );
    await expect(
      verifyAuthSuccessCandidate({
        platform: "twitter",
        connectionId: null,
        proof: "other-user.sig",
      }),
    ).resolves.toEqual({ ok: false, reason: "rejected" });
  });

  it("fails closed on a replayed already-consumed proof", async () => {
    apiMock.mockRejectedValueOnce(
      new ApiError(400, "bad_request", "already_used"),
    );
    await expect(
      verifyAuthSuccessCandidate({
        platform: "discord",
        connectionId: null,
        proof: "replayed.sig",
      }),
    ).resolves.toEqual({ ok: false, reason: "rejected" });
  });

  it("does not accept a proof alone after anonymous ownership 401", async () => {
    // Generic OAuth with connection_id: proof rejected (no session), ownership
    // also unauthorized — must not fall back to a personal Connected claim.
    apiMock
      .mockRejectedValueOnce(new ApiError(401, "unauthorized", "no session"))
      .mockRejectedValueOnce(new ApiError(401, "unauthorized", "no session"));
    await expect(
      verifyAuthSuccessCandidate({
        platform: "github",
        connectionId: "conn-1",
        proof: "p.sig",
      }),
    ).resolves.toEqual({ ok: false, reason: "rejected" });
  });

  it("retries ownership without bearer after a stale-token 401 (ownership-only path)", async () => {
    bearerTokenRef.current = "stale.jwt.token";
    apiMock
      .mockRejectedValueOnce(new ApiError(401, "unauthorized", "bad bearer"))
      .mockRejectedValueOnce(new ApiError(404, "not_found", "not yours"));
    await expect(
      verifyAuthSuccessCandidate({
        platform: "github",
        connectionId: "conn-other",
        proof: null,
      }),
    ).resolves.toEqual({ ok: false, reason: "rejected" });
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(apiMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/oauth/connections/conn-other",
      expect.objectContaining({ skipAuth: true }),
    );
  });

  it("rejects forged connection ownership", async () => {
    apiMock.mockRejectedValueOnce(
      new ApiError(404, "not_found", "Connection not found"),
    );
    await expect(
      verifyAuthSuccessCandidate({
        platform: "github",
        connectionId: "forged",
        proof: null,
      }),
    ).resolves.toEqual({ ok: false, reason: "rejected" });
  });

  it("surfaces verification outages separately from rejection", async () => {
    apiMock.mockRejectedValueOnce(
      new ApiError(503, "unavailable", "downstream down"),
    );
    await expect(
      verifyAuthSuccessCandidate({
        platform: "github",
        connectionId: "conn-1",
        proof: null,
      }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("treats HTTP 429 rate limits as unavailable (retryable)", async () => {
    apiMock.mockRejectedValueOnce(
      new ApiError(429, "rate_limited", "too many requests"),
    );
    await expect(
      verifyAuthSuccessCandidate({
        platform: "github",
        connectionId: null,
        proof: "p.sig",
      }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("falls back to session ownership when proof fails but connection_id remains", async () => {
    apiMock
      .mockRejectedValueOnce(new ApiError(400, "bad_request", "expired proof"))
      .mockResolvedValueOnce({
        connection: { id: "conn-1", platform: "github", status: "active" },
      });
    await expect(
      verifyAuthSuccessCandidate({
        platform: "github",
        connectionId: "conn-1",
        proof: "expired.sig",
      }),
    ).resolves.toEqual({
      ok: true,
      platform: "github",
      platformDisplay: "GitHub",
      connectionId: "conn-1",
    });
    expect(apiMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/oauth/success-proof/verify?proof=expired.sig",
      expect.any(Object),
    );
    expect(apiMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/oauth/connections/conn-1",
      expect.any(Object),
    );
  });

  it("does not fall back without a connection id when proof is rejected", async () => {
    apiMock.mockRejectedValueOnce(
      new ApiError(400, "bad_request", "bad proof"),
    );
    await expect(
      verifyAuthSuccessCandidate({
        platform: "twitter",
        connectionId: null,
        proof: "bad.sig",
      }),
    ).resolves.toEqual({ ok: false, reason: "rejected" });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("keeps verifier outages as unavailable when ownership fallback is sessionless", async () => {
    apiMock
      .mockRejectedValueOnce(
        new ApiError(503, "unavailable", "proof verifier down"),
      )
      .mockRejectedValueOnce(new ApiError(401, "unauthorized", "no session"));
    await expect(
      verifyAuthSuccessCandidate({
        platform: "github",
        connectionId: "conn-1",
        proof: "p.sig",
      }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("verifies session-bound proofs against Cloud from loopback web origins", async () => {
    setPageOrigin("http://localhost:5173");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          platform: "github",
          connectionId: "conn-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      verifyAuthSuccessCandidate({
        platform: "github",
        connectionId: "conn-1",
        proof: "loopback.sig",
      }),
    ).resolves.toEqual({
      ok: true,
      platform: "github",
      platformDisplay: "GitHub",
      connectionId: "conn-1",
    });

    expect(apiMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^https:\/\/api\.eliza\.app\/api\/v1\/oauth\/success-proof\/verify\?proof=loopback\.sig$/,
      ),
      expect.objectContaining({ credentials: "include", method: "GET" }),
    );
  });

  it("rejects ownership DTOs that omit status", async () => {
    apiMock.mockResolvedValueOnce({
      connection: { id: "conn-1", platform: "github" },
    });
    await expect(
      verifyAuthSuccessCandidate({
        platform: "github",
        connectionId: "conn-1",
        proof: null,
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

  it("shows verified success after session-bound proof verification", async () => {
    apiMock.mockResolvedValueOnce({
      ok: true,
      platform: "github",
      connectionId: "conn-1",
    });
    render(<AuthSuccessPage />);
    expect(await screen.findByText("GitHub Connected")).toBeTruthy();
  });

  it("does not claim Connected for a forwarded proof without a session", async () => {
    apiMock.mockRejectedValueOnce(
      new ApiError(401, "unauthorized", "no session"),
    );
    searchParamsRef.current = new URLSearchParams(
      "twitter_connected=true&platform=twitter&proof=forwarded.sig",
    );
    render(<AuthSuccessPage />);
    expect(
      await screen.findByText("Connection Could Not Be Verified"),
    ).toBeTruthy();
    expect(screen.queryByText("Twitter Connected")).toBeNull();
  });

  it("shows unavailable UI on verification outage", async () => {
    apiMock.mockRejectedValueOnce(
      new ApiError(503, "unavailable", "downstream down"),
    );
    searchParamsRef.current = new URLSearchParams(
      "platform=github&connection_id=conn-1",
    );
    render(<AuthSuccessPage />);
    expect(await screen.findByText("Could Not Reach Eliza Cloud")).toBeTruthy();
    expect(screen.getByText("Try Again")).toBeTruthy();
  });

  it("auto-closes only when verified success has a live opener", async () => {
    apiMock.mockResolvedValueOnce({
      ok: true,
      platform: "github",
      connectionId: "conn-1",
    });
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    Object.defineProperty(window, "opener", {
      value: { closed: false },
      configurable: true,
    });
    vi.useFakeTimers();
    render(<AuthSuccessPage />);
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
