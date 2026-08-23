/** Tenant-isolation coverage for every Organization React Query hook. */
// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const sessionState = vi.hoisted(() => ({
  current: {
    ready: false,
    authenticated: false,
    user: null as { id: string; email: string } | null,
  },
}));

vi.mock("../../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api-client")>(
    "../../lib/api-client",
  );
  return { ...actual, api: apiMock };
});
vi.mock("../../lib/use-session-auth", () => ({
  useSessionAuth: () => sessionState.current,
}));

import {
  credentialsQueryKey,
  useOrganizationCredentials,
} from "./use-credentials";
import {
  organizationQueryKeys,
  useOrganizationInvites,
  useOrganizationMembers,
  useOrganizationUser,
} from "./use-organization";

function authenticatedAs(userId: string): void {
  sessionState.current = {
    ready: true,
    authenticated: true,
    user: { id: userId, email: `${userId}@example.test` },
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
}

function queryWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function mockOrganizationApi(): void {
  apiMock.mockImplementation((path: string) => {
    const userId = sessionState.current.user?.id;
    if (!userId) return Promise.reject(new Error("missing test identity"));

    const data = (() => {
      switch (path) {
        case "/api/v1/user":
          return { id: userId, email: `${userId}@example.test` };
        case "/api/organizations/members":
          return [{ id: `${userId}-member` }];
        case "/api/organizations/invites":
          return [{ id: `${userId}-invite` }];
        case "/api/organizations/credentials":
          return [{ id: `${userId}-credential` }];
        default:
          throw new Error(`unexpected call: ${path}`);
      }
    })();

    return Promise.resolve({ success: true, data });
  });
}

beforeEach(() => {
  apiMock.mockReset();
  sessionState.current = {
    ready: false,
    authenticated: false,
    user: null,
  };
});

afterEach(() => {
  cleanup();
});

describe("Organization queries — authenticated cache isolation", () => {
  it("does not reuse Organization data when the authenticated identity changes", async () => {
    authenticatedAs("user-one");
    mockOrganizationApi();
    const client = createQueryClient();

    const { result, rerender } = renderHook(
      () => ({
        user: useOrganizationUser(),
        members: useOrganizationMembers(true),
        invites: useOrganizationInvites(true),
        credentials: useOrganizationCredentials(),
      }),
      { wrapper: queryWrapper(client) },
    );

    await waitFor(() => {
      expect(result.current.user.data?.id).toBe("user-one");
      expect(result.current.members.data?.[0]?.id).toBe("user-one-member");
      expect(result.current.invites.data?.[0]?.id).toBe("user-one-invite");
      expect(result.current.credentials.data?.[0]?.id).toBe(
        "user-one-credential",
      );
    });

    authenticatedAs("user-two");
    rerender();

    expect(result.current.user.data).toBeUndefined();
    expect(result.current.members.data).toBeUndefined();
    expect(result.current.invites.data).toBeUndefined();
    expect(result.current.credentials.data).toBeUndefined();

    await waitFor(() => {
      expect(result.current.user.data?.id).toBe("user-two");
      expect(result.current.members.data?.[0]?.id).toBe("user-two-member");
      expect(result.current.invites.data?.[0]?.id).toBe("user-two-invite");
      expect(result.current.credentials.data?.[0]?.id).toBe(
        "user-two-credential",
      );
    });
    expect(apiMock).toHaveBeenCalledTimes(8);

    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    for (const identity of ["user-one", "user-two"]) {
      expect(keys).toContainEqual([
        ...organizationQueryKeys.user,
        "auth",
        identity,
      ]);
      expect(keys).toContainEqual([
        ...organizationQueryKeys.members,
        "auth",
        identity,
      ]);
      expect(keys).toContainEqual([
        ...organizationQueryKeys.invites,
        "auth",
        identity,
      ]);
      expect(keys).toContainEqual([...credentialsQueryKey, "auth", identity]);
    }
  });

  it("does not request Organization data while signed out", () => {
    const { result } = renderHook(
      () => ({
        user: useOrganizationUser(),
        members: useOrganizationMembers(true),
        invites: useOrganizationInvites(true),
        credentials: useOrganizationCredentials(),
      }),
      { wrapper: queryWrapper(createQueryClient()) },
    );

    expect(result.current.user.fetchStatus).toBe("idle");
    expect(result.current.members.fetchStatus).toBe("idle");
    expect(result.current.invites.fetchStatus).toBe("idle");
    expect(result.current.credentials.fetchStatus).toBe("idle");
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("preserves the caller RBAC gate for members and invites", () => {
    authenticatedAs("user-one");
    mockOrganizationApi();

    const { result } = renderHook(
      () => ({
        members: useOrganizationMembers(false),
        invites: useOrganizationInvites(false),
      }),
      { wrapper: queryWrapper(createQueryClient()) },
    );

    expect(result.current.members.fetchStatus).toBe("idle");
    expect(result.current.invites.fetchStatus).toBe("idle");
    expect(apiMock).not.toHaveBeenCalled();
  });
});
