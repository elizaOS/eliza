import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the dependencies before importing the module under test
vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth-mode", () => ({
  DEV_SESSION_COOKIE: "soulmates-dev-session",
  isAuthEnabled: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/env", () => ({
  isDevLoginEnabled: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  getUserById: vi.fn(),
}));

import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { isAuthEnabled } from "@/lib/auth-mode";
import { isDevLoginEnabled } from "@/lib/env";
import { getUserById } from "@/lib/store";
import { requireAdminUser, requireSessionUser } from "../lib/session";

const mockCookies = cookies as ReturnType<typeof vi.fn>;
const mockGetServerSession = getServerSession as ReturnType<typeof vi.fn>;
const mockIsAuthEnabled = isAuthEnabled as ReturnType<typeof vi.fn>;
const mockIsDevLoginEnabled = isDevLoginEnabled as ReturnType<typeof vi.fn>;
const mockGetUserById = getUserById as ReturnType<typeof vi.fn>;

describe("requireSessionUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("production mode (auth enabled)", () => {
    beforeEach(() => {
      mockIsAuthEnabled.mockReturnValue(true);
    });

    it("returns null when no session exists", async () => {
      mockGetServerSession.mockResolvedValue(null);

      const result = await requireSessionUser();

      expect(result).toBeNull();
      expect(mockGetServerSession).toHaveBeenCalled();
    });

    it("returns null when session has no user id", async () => {
      mockGetServerSession.mockResolvedValue({ user: {} });

      const result = await requireSessionUser();

      expect(result).toBeNull();
    });

    it("returns user when session is valid", async () => {
      const mockUser = {
        id: "user-123",
        phone: "+15551234567",
        name: "Test User",
        email: "test@example.com",
        location: "NYC",
        credits: 100,
        status: "active",
        isAdmin: false,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };

      mockGetServerSession.mockResolvedValue({ user: { id: "user-123" } });
      mockGetUserById.mockResolvedValue(mockUser);

      const result = await requireSessionUser();

      expect(result).toEqual(mockUser);
      expect(mockGetUserById).toHaveBeenCalledWith("user-123");
    });

    it("returns null when user not found in database", async () => {
      mockGetServerSession.mockResolvedValue({ user: { id: "nonexistent" } });
      mockGetUserById.mockResolvedValue(null);

      const result = await requireSessionUser();

      expect(result).toBeNull();
    });
  });

  describe("dev mode (auth disabled)", () => {
    beforeEach(() => {
      mockIsAuthEnabled.mockReturnValue(false);
    });

    it("returns null when dev login is disabled", async () => {
      mockIsDevLoginEnabled.mockReturnValue(false);

      const result = await requireSessionUser();

      expect(result).toBeNull();
      expect(mockGetServerSession).not.toHaveBeenCalled();
    });

    it("returns null when no dev session cookie exists", async () => {
      mockIsDevLoginEnabled.mockReturnValue(true);
      mockCookies.mockResolvedValue({
        get: vi.fn().mockReturnValue(undefined),
      });

      const result = await requireSessionUser();

      expect(result).toBeNull();
    });

    it("returns user when dev session cookie exists", async () => {
      const mockUser = {
        id: "dev-user-123",
        phone: "+15555550100",
        name: "Dev User",
        email: null,
        location: null,
        credits: 0,
        status: "active",
        isAdmin: true,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };

      mockIsDevLoginEnabled.mockReturnValue(true);
      mockCookies.mockResolvedValue({
        get: vi.fn().mockReturnValue({ value: "dev-user-123" }),
      });
      mockGetUserById.mockResolvedValue(mockUser);

      const result = await requireSessionUser();

      expect(result).toEqual(mockUser);
      // VERIFIED: Uses actual user ID from cookie, not hardcoded
      expect(mockGetUserById).toHaveBeenCalledWith("dev-user-123");
    });

    it("returns null when user ID in cookie is invalid", async () => {
      mockIsDevLoginEnabled.mockReturnValue(true);
      mockCookies.mockResolvedValue({
        get: vi.fn().mockReturnValue({ value: "invalid-user-id" }),
      });
      mockGetUserById.mockResolvedValue(null);

      const result = await requireSessionUser();

      expect(result).toBeNull();
    });
  });
});

describe("requireAdminUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAuthEnabled.mockReturnValue(true);
  });

  it("returns null when no session exists", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const result = await requireAdminUser();

    expect(result).toBeNull();
  });

  it("returns null when user is not admin", async () => {
    const mockUser = {
      id: "user-123",
      phone: "+15551234567",
      name: "Regular User",
      email: "user@example.com",
      location: "NYC",
      credits: 100,
      status: "active",
      isAdmin: false,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };

    mockGetServerSession.mockResolvedValue({ user: { id: "user-123" } });
    mockGetUserById.mockResolvedValue(mockUser);

    const result = await requireAdminUser();

    expect(result).toBeNull();
  });

  it("returns user when user is admin", async () => {
    const mockAdmin = {
      id: "admin-123",
      phone: "+15559999999",
      name: "Admin User",
      email: "admin@example.com",
      location: "NYC",
      credits: 1000,
      status: "active",
      isAdmin: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };

    mockGetServerSession.mockResolvedValue({ user: { id: "admin-123" } });
    mockGetUserById.mockResolvedValue(mockAdmin);

    const result = await requireAdminUser();

    expect(result).toEqual(mockAdmin);
    expect(result?.isAdmin).toBe(true);
  });
});
