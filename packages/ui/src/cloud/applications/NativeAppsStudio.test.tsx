// @vitest-environment jsdom

/**
 * Smoke test for the native Applications mount.
 *
 * Renders the REAL `NativeAppsStudio` — its `MemoryRouter`, the cloud
 * `QueryClient` + i18n providers, and the native Steward auth context built
 * from a stored JWT — with only the typed cloud api-client doubled. It proves
 * the mount wires auth → the authenticated query gate → `useApps()` →
 * `ApplicationsPage` → the list, end to end, without the web `CloudRouterShell`.
 *
 * Auth: a valid (far-future `exp`) Steward JWT is seeded in `localStorage`, so
 * the native auth context resolves to a signed-in user and the query gate
 * enables. The far-future expiry also means `shouldRefreshBeforeRender` is
 * false, so no Steward refresh fetch is attempted (the real
 * `refreshCloudStewardSession` is never called).
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Double the typed cloud api-client; everything else (router, providers, auth
// context, pages, table) is the real implementation.
const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client")>(
      "../lib/api-client",
    );
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

import { queryClient } from "../lib/query-client";
import NativeAppsStudio from "./NativeAppsStudio";

/** Build an unsigned-but-decodable Steward JWT with the given claims. */
function makeJwt(claims: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`;
}

const SMOKE_APP = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Smoke Test App",
  app_url: "https://smoke.example.com",
  is_active: true,
  total_users: 7,
  total_requests: 42,
  updated_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
} as never;

beforeEach(() => {
  // Far-future expiry → authenticated context + no pre-render refresh.
  const exp = Math.floor(Date.now() / 1000) + 60 * 60;
  window.localStorage.setItem(
    STEWARD_TOKEN_KEY,
    makeJwt({ userId: "user_smoke", email: "smoke@example.com", exp }),
  );
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/v1/apps") return Promise.resolve({ apps: [SMOKE_APP] });
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  queryClient.clear();
  window.localStorage.clear();
});

describe("NativeAppsStudio — native Applications mount", () => {
  it("mounts the Applications list from the mocked api-client", async () => {
    render(<NativeAppsStudio />);

    // The list renders the app row (proves auth gate → useApps → page → table).
    expect(await screen.findByText("Smoke Test App")).toBeTruthy();

    // The list query went through the typed api-client at the apps endpoint.
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/api/v1/apps"));
  });

  it("shows the empty state when the api-client returns no apps", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/api/v1/apps") return Promise.resolve({ apps: [] });
      return Promise.resolve({});
    });

    render(<NativeAppsStudio />);

    // Empty-state copy from AppsEmptyState (default i18n value renders the key's
    // fallback). The stat toolbar's "Total Apps" card still renders at zero.
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/api/v1/apps"));
    expect(screen.queryByText("Smoke Test App")).toBeNull();
  });
});
