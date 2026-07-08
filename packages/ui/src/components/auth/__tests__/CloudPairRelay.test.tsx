// @vitest-environment jsdom

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
  CLOUD_PAIR_SESSION_STORAGE_KEY,
  CloudHostedAgentAuthNotice,
  CloudPairExchangeError,
  CloudPairRelay,
  exchangeCloudPairToken,
  getCloudPairTokenFromLocation,
  isElizaCloudHostedLocation,
  persistCloudPairApiToken,
  resolveCloudPairExchangeUrl,
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
      "https://elizacloud.ai/api/auth/pair",
    );
    expect(
      resolveCloudPairExchangeUrl("https://api.elizacloud.ai/api/v1"),
    ).toBe("https://api.elizacloud.ai/api/auth/pair");
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

  it("persists the paired API key into the app token channels", () => {
    persistCloudPairApiToken(" agent-key ");

    expect(getBootConfig().apiToken).toBe("agent-key");
    expect(getElizaApiToken()).toBe("agent-key");
    expect(window.sessionStorage.getItem(CLOUD_PAIR_SESSION_STORAGE_KEY)).toBe(
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

  it("shows a Cloud-hosted auth notice without the local password wall", () => {
    render(<CloudHostedAgentAuthNotice />);

    expect(screen.getByText("Open this agent from Eliza Cloud")).toBeTruthy();
    expect(screen.queryByText("Display name")).toBeNull();
    expect(screen.queryByText("Password")).toBeNull();
    expect(screen.queryByText("Remember this device for 30 days")).toBeNull();
  });
});
