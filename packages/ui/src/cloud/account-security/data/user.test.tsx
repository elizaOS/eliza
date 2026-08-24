/** Verifies the `useUserProfile` hook (session gating, `/api/v1/user` envelope unwrap, DTO → UserProfile adaptation) against mocked transport/session collaborators only. */
// @vitest-environment jsdom

import type { CurrentUserDto } from "@elizaos/cloud-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../lib/api-client";
import { useSessionAuth } from "../../lib/use-session-auth";
import { useUserProfile } from "./user";

// The network transport and the session provider are the two boundaries this
// hook owns glue for; both are replaced whole so the suite drives the real
// gating, envelope-unwrapping, and Date-adaptation logic in between.
vi.mock("../../lib/api-client", () => ({ api: vi.fn() }));
vi.mock("../../lib/use-session-auth", () => ({ useSessionAuth: vi.fn() }));

const apiMock = vi.mocked(api);
const sessionMock = vi.mocked(useSessionAuth);

function makeDto(overrides: Partial<CurrentUserDto> = {}): CurrentUserDto {
  return {
    id: "user-1",
    email: "operator@example.com",
    email_verified: true,
    wallet_address: null,
    wallet_chain_type: null,
    wallet_verified: false,
    name: "Operator",
    avatar: null,
    organization_id: "org-1",
    role: "owner",
    steward_user_id: "steward-1",
    telegram_id: null,
    telegram_username: null,
    telegram_first_name: null,
    telegram_photo_url: null,
    discord_id: null,
    discord_username: null,
    discord_global_name: null,
    discord_avatar_url: null,
    whatsapp_id: null,
    whatsapp_name: null,
    phone_number: null,
    phone_verified: null,
    is_anonymous: false,
    anonymous_session_id: null,
    expires_at: "2026-12-31T23:59:59.000Z",
    nickname: null,
    work_function: null,
    preferences: null,
    email_notifications: true,
    response_notifications: false,
    is_active: true,
    created_at: "2026-01-15T10:30:00.000Z",
    updated_at: "2026-02-20T12:00:00.000Z",
    organization: {
      id: "org-1",
      name: "Acme",
      slug: "acme",
      billing_email: "billing@acme.example.com",
      credit_balance: "4200",
      is_active: true,
      created_at: "2025-11-01T08:00:00.000Z",
      updated_at: "2026-03-05T09:45:00.000Z",
    },
    ...overrides,
  };
}

function setSession(state: {
  ready: boolean;
  authenticated: boolean;
  userId?: string;
}): void {
  sessionMock.mockReturnValue({
    ready: state.ready,
    authenticated: state.authenticated,
    user:
      state.userId === undefined
        ? null
        : { id: state.userId, email: "operator@example.com" },
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function mountProfile() {
  return renderHook(() => useUserProfile(), { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("useUserProfile", () => {
  it("does not fire the profile request before the session check is ready", async () => {
    setSession({ ready: false, authenticated: true, userId: "user-1" });

    const { result } = mountProfile();

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(apiMock).not.toHaveBeenCalled();
    expect(result.current.isReady).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it("does not fire the profile request when the session is ready but signed out", async () => {
    setSession({ ready: true, authenticated: false });

    const { result } = mountProfile();

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(apiMock).not.toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it("fetches /api/v1/user once for a signed-in session and adapts timestamps to Dates", async () => {
    setSession({ ready: true, authenticated: true, userId: "user-1" });
    apiMock.mockResolvedValue({ success: true, data: makeDto() });

    const { result } = mountProfile();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith("/api/v1/user");
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.isReady).toBe(true);

    const profile = result.current.user;
    if (!profile) throw new Error("expected the adapted profile to resolve");

    // Envelope unwrapped: fields come from res.data, not the raw envelope.
    expect(profile.email).toBe("operator@example.com");
    expect(profile.role).toBe("owner");
    expect(profile.organization_id).toBe("org-1");
    expect(profile.wallet_verified).toBe(false);
    expect(profile.email_notifications).toBe(true);
    expect(profile.response_notifications).toBe(false);
    expect(profile.is_anonymous).toBe(false);
    expect(profile.is_active).toBe(true);
    expect(profile.steward_user_id).toBe("steward-1");

    // Timestamp strings arrive as real Date instances.
    expect(profile.created_at).toBeInstanceOf(Date);
    expect(profile.created_at.toISOString()).toBe("2026-01-15T10:30:00.000Z");
    expect(profile.updated_at).toBeInstanceOf(Date);
    expect(profile.updated_at.toISOString()).toBe("2026-02-20T12:00:00.000Z");
    expect(profile.expires_at).toBeInstanceOf(Date);
    expect(profile.expires_at?.toISOString()).toBe("2026-12-31T23:59:59.000Z");

    // Organization summary keeps its scalar fields and gains Date columns.
    expect(profile.organization).not.toBeNull();
    expect(profile.organization?.name).toBe("Acme");
    expect(profile.organization?.slug).toBe("acme");
    expect(profile.organization?.credit_balance).toBe("4200");
    expect(profile.organization?.billing_email).toBe(
      "billing@acme.example.com",
    );
    expect(profile.organization?.created_at).toBeInstanceOf(Date);
    expect(profile.organization?.created_at.toISOString()).toBe(
      "2025-11-01T08:00:00.000Z",
    );
    expect(profile.organization?.updated_at.toISOString()).toBe(
      "2026-03-05T09:45:00.000Z",
    );
  });

  it("keeps an absent organization as null instead of fabricating one", async () => {
    setSession({ ready: true, authenticated: true, userId: "user-1" });
    apiMock.mockResolvedValue({
      success: true,
      data: makeDto({ organization: null }),
    });

    const { result } = mountProfile();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const profile = result.current.user;
    if (!profile) throw new Error("expected the adapted profile to resolve");
    expect(profile.organization).toBeNull();
    expect(profile.created_at).toBeInstanceOf(Date);
  });

  it("reads a missing expiry as null rather than an invalid Date", async () => {
    setSession({ ready: true, authenticated: true, userId: "user-1" });
    apiMock.mockResolvedValue({
      success: true,
      data: makeDto({ expires_at: null }),
    });

    const { result } = mountProfile();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const profile = result.current.user;
    if (!profile) throw new Error("expected the adapted profile to resolve");
    expect(profile.expires_at).toBeNull();
    expect(profile.updated_at).toBeInstanceOf(Date);
  });

  it("surfaces a failed profile request as an error without retrying or exposing a user", async () => {
    setSession({ ready: true, authenticated: true, userId: "user-1" });
    apiMock.mockRejectedValue(new Error("request failed with status 503"));

    const { result } = mountProfile();

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(result.current.user).toBeNull();
  });
});
