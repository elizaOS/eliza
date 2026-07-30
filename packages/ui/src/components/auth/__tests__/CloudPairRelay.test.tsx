// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BOOT_CONFIG,
  getBootConfig,
  setBootConfig,
} from "../../../config/boot-config";
import {
  clearElizaApiToken,
  getElizaApiToken,
} from "../../../utils/eliza-globals";
import {
  CLOUD_PAIR_LOCAL_STORAGE_KEY,
  CLOUD_PAIR_SESSION_STORAGE_KEY,
  CloudHostedAgentAuthNotice,
  CloudPairExchangeError,
  CloudPairRelay,
  exchangeAuthenticatedNativeCloudPairToken,
  exchangeCloudPairToken,
  getCloudPairTokenFromLocation,
  isElizaCloudHostedLocation,
  persistCloudPairApiToken,
  resolveCloudHostedAgentUrl,
  resolveCloudPairExchangeUrl,
  resolveNativeCloudPairExchangeUrl,
} from "../CloudPairRelay";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CloudPairRelay", () => {
  beforeEach(() => {
    setBootConfig(DEFAULT_BOOT_CONFIG);
    clearElizaApiToken();
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("detects only /pair URLs with a non-empty token", () => {
    expect(
      getCloudPairTokenFromLocation({
        pathname: "/pair",
        search: "?token=pair-token",
      }),
    ).toBe("pair-token");
    expect(
      getCloudPairTokenFromLocation({
        pathname: "/pair/",
        search: "?token=%20pair-token%20",
      }),
    ).toBe("pair-token");
    expect(
      getCloudPairTokenFromLocation({
        pathname: "/chat",
        search: "?token=pair-token",
      }),
    ).toBeNull();
    expect(
      getCloudPairTokenFromLocation({
        pathname: "/pair",
        search: "?token= ",
      }),
    ).toBeNull();
  });

  it("resolves the Cloud pair exchange endpoint from site and API bases", () => {
    expect(resolveCloudPairExchangeUrl("https://elizacloud.ai")).toBe(
      "https://api.elizacloud.ai/api/auth/pair",
    );
    expect(
      resolveCloudPairExchangeUrl("https://api.elizacloud.ai/api/v1"),
    ).toBe("https://api.elizacloud.ai/api/auth/pair");
    expect(resolveCloudPairExchangeUrl("https://www.elizacloud.ai")).toBe(
      "https://api.elizacloud.ai/api/auth/pair",
    );
    expect(resolveNativeCloudPairExchangeUrl("https://elizacloud.ai")).toBe(
      "https://api.elizacloud.ai/api/auth/pair/native",
    );
    expect(
      resolveNativeCloudPairExchangeUrl("https://staging.elizacloud.ai"),
    ).toBe("https://api-staging.elizacloud.ai/api/auth/pair/native");
    expect(
      resolveNativeCloudPairExchangeUrl("https://api.elizacloud.ai/api/v1"),
    ).toBe("https://api.elizacloud.ai/api/auth/pair/native");
  });

  it("detects Eliza Cloud-hosted surfaces without matching localhost", () => {
    expect(
      isElizaCloudHostedLocation({
        protocol: "https:",
        hostname: "23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
      }),
    ).toBe(true);
    expect(
      isElizaCloudHostedLocation({
        protocol: "https:",
        hostname: "app.elizacloud.ai",
      }),
    ).toBe(true);
    expect(
      isElizaCloudHostedLocation({
        protocol: "http:",
        hostname: "localhost",
      }),
    ).toBe(false);
  });

  it("exchanges the pairing token with Cloud and returns the agent API key", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ apiKey: "agent-key" }));

    await expect(
      exchangeCloudPairToken("pair-token", {
        fetchFn: fetchFn as unknown as typeof fetch,
        cloudApiBase: "https://api.elizacloud.ai/api/v1",
      }),
    ).resolves.toBe("agent-key");

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.elizacloud.ai/api/auth/pair",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "pair-token" }),
      }),
    );
  });

  it("uses the authenticated identity-bound endpoint only for native pairing", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ apiKey: "native-key" }));

    await expect(
      exchangeAuthenticatedNativeCloudPairToken("pair-token", {
        cloudToken: "steward.jwt.token",
        agentId: "23766030-c096-4a14-932a-a4e43c562432",
        expectedOrigin:
          "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
        fetchFn: fetchFn as unknown as typeof fetch,
        cloudApiBase: "https://api.elizacloud.ai/api/v1",
      }),
    ).resolves.toBe("native-key");

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.elizacloud.ai/api/auth/pair/native",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer steward.jwt.token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          token: "pair-token",
          agentId: "23766030-c096-4a14-932a-a4e43c562432",
          expectedOrigin:
            "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
        }),
      }),
    );
  });

  it("preserves the native recovery code on exchange failures", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        {
          success: false,
          error: "Cloud authentication required",
          code: "cloud_auth_required",
        },
        401,
      ),
    );

    const error = await exchangeAuthenticatedNativeCloudPairToken(
      "pair-token",
      {
        cloudToken: "expired.steward.token",
        agentId: "23766030-c096-4a14-932a-a4e43c562432",
        expectedOrigin:
          "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
        fetchFn: fetchFn as unknown as typeof fetch,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudPairExchangeError);
    expect(error).toMatchObject({
      status: 401,
      code: "cloud_auth_required",
    });
  });

  it("persists the paired API key into the app token channels", () => {
    persistCloudPairApiToken(" agent-key ");

    expect(getBootConfig().apiToken).toBe("agent-key");
    expect(getElizaApiToken()).toBe("agent-key");
    expect(window.sessionStorage.getItem(CLOUD_PAIR_SESSION_STORAGE_KEY)).toBe(
      "agent-key",
    );
    expect(window.localStorage.getItem(CLOUD_PAIR_LOCAL_STORAGE_KEY)).toBe(
      "agent-key",
    );
    expect(
      (globalThis as Record<string, unknown>).__ELIZA_APP_BOOT_CONFIG__,
    ).toEqual(expect.objectContaining({ apiToken: "agent-key" }));
  });

  it("pairs, stores the returned API key, and redirects without showing LoginView", async () => {
    const onPaired = vi.fn();

    render(
      <CloudPairRelay
        token="pair-token"
        exchangeFn={vi.fn(async () => "agent-key")}
        onPaired={onPaired}
      />,
    );

    expect(screen.getByText("Signing in to your agent")).toBeTruthy();
    expect(screen.queryByText("Display name")).toBeNull();
    expect(screen.queryByText("Password")).toBeNull();

    await waitFor(() => expect(onPaired).toHaveBeenCalledOnce());
    expect(getBootConfig().apiToken).toBe("agent-key");
    expect(window.sessionStorage.getItem(CLOUD_PAIR_SESSION_STORAGE_KEY)).toBe(
      "agent-key",
    );
    expect(window.localStorage.getItem(CLOUD_PAIR_LOCAL_STORAGE_KEY)).toBe(
      "agent-key",
    );
  });

  it("shows a clean Cloud-pair error instead of the local password form", async () => {
    render(
      <CloudPairRelay
        token="expired-token"
        exchangeFn={vi.fn(async () => {
          throw new CloudPairExchangeError("expired", 410);
        })}
        onPaired={vi.fn()}
      />,
    );

    await screen.findByText("Sign-in link expired");
    expect(
      screen.getByText("Open this agent from Eliza Cloud again to continue."),
    ).toBeTruthy();
    expect(screen.queryByText("Display name")).toBeNull();
    expect(screen.queryByText("Password")).toBeNull();
    expect(screen.queryByText("Remember this device for 30 days")).toBeNull();
  });

  it("shows a Cloud-hosted auth notice with a tappable Cloud reopen CTA", () => {
    render(<CloudHostedAgentAuthNotice />);

    expect(screen.getByText("Open this agent from Eliza Cloud")).toBeTruthy();
    const link = screen.getByRole("link", {
      name: "Re-open from Eliza Cloud",
    });
    expect(link.getAttribute("href")).toBe(
      "https://elizacloud.ai/dashboard/agents",
    );
    expect(link.getAttribute("target")).toBe("_top");
    expect(screen.queryByText("Display name")).toBeNull();
    expect(screen.queryByText("Password")).toBeNull();
    expect(screen.queryByText("Remember this device for 30 days")).toBeNull();
  });

  it("resolves production, staging, and agent-specific Cloud reopen URLs", () => {
    expect(
      resolveCloudHostedAgentUrl({
        hostname: "agent-123.elizacloud.ai",
      }),
    ).toBe("https://elizacloud.ai/dashboard/agents/agent-123");
    expect(
      resolveCloudHostedAgentUrl({
        hostname: "agent-123.staging.elizacloud.ai",
      }),
    ).toBe("https://staging.elizacloud.ai/dashboard/agents/agent-123");
    expect(
      resolveCloudHostedAgentUrl({
        hostname: "app-staging.elizacloud.ai",
      }),
    ).toBe("https://staging.elizacloud.ai/dashboard/agents");
  });
});

describe("CloudPairRelay short-viewport scroll", () => {
  // The pairing + hosted-agent notice screens are full-viewport centered cards.
  // On short screens (Light Phone III, 1080×1240) a flex `justify-center`
  // pins the card's center above scrollTop 0, so the error copy + "Back to
  // Eliza Cloud" fell below an unreachable fold. The wrapper must be
  // `overflow-y-auto` with the card `my-auto` (centers when it fits, scrolls
  // from the top when it overflows) — jsdom can't measure layout, so scan the
  // source, matching login-page.safe-area.test.tsx.
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "CloudPairRelay.tsx"),
    "utf8",
  );

  it("makes both pair screens scroll instead of clipping when taller than the viewport", () => {
    const scrollers = SRC.match(/min-h-\[100dvh\][^"]*overflow-y-auto/g) ?? [];
    expect(
      scrollers.length,
      "both the pairing relay and the hosted-agent notice must be overflow-y-auto",
    ).toBe(2);
  });

  it("centers the card with my-auto, not a top-clipping justify-center", () => {
    expect(
      /\bmy-auto\b[^"]*\bmax-w-\[2/.test(SRC),
      "the card must center via my-auto so its top stays reachable while scrolling",
    ).toBe(true);
    expect(
      /min-h-\[100dvh\][^"]*items-center justify-center/.test(SRC),
      "the wrapper must not use the top-clipping items-center justify-center centering",
    ).toBe(false);
  });
});
