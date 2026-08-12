/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url":"https://app-staging.elizacloud.ai/apps"}
 *
 * Exercises app-origin Cloud session repair through the real cookie probe,
 * token store, and staging API endpoint resolver with an HTTP-bound refresh
 * double.
 */
import {
  hasStewardAuthedCookie,
  STEWARD_REFRESH_ENDPOINT,
  STEWARD_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client-cloud", () => ({
  refreshCloudStewardSession: async (options?: { endpoint?: string }) => {
    const response = await fetch(
      options?.endpoint ?? STEWARD_REFRESH_ENDPOINT,
      {
        method: "POST",
        credentials: "include",
      },
    );
    if (!response.ok) return null;
    return (await response.json()) as { token?: string };
  },
}));

import { ensureCloudSessionForRepair } from "./cloud-session-refresh-for-repair";

const STAGING_AUTHED_COOKIE = "steward-authed-staging";

function writeTestCookie(value: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom must drive the browser marker read by production.
  document.cookie = value;
}

describe("app-origin Cloud session repair", () => {
  beforeEach(() => {
    localStorage.clear();
    writeTestCookie(`${STAGING_AUTHED_COOKIE}=1; Domain=elizacloud.ai; Path=/`);
  });

  afterEach(() => {
    writeTestCookie(
      `${STAGING_AUTHED_COOKIE}=; Max-Age=0; Domain=elizacloud.ai; Path=/`,
    );
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("recovers an empty app-origin token mirror from the shared staging Cloud cookie", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ token: "recovered-staging-token", expiresIn: 900 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(hasStewardAuthedCookie()).toBe(true);
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();

    await expect(ensureCloudSessionForRepair()).resolves.toBe(
      "recovered-staging-token",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api-staging.elizacloud.ai/api/auth/steward-refresh",
      {
        method: "POST",
        credentials: "include",
      },
    );
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
      "recovered-staging-token",
    );
  });
});
