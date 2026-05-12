import { describe, expect, mock, test } from "bun:test";
import { SignJWT } from "jose";

const TEST_USER = {
  id: "cloud-user-1",
  email: "user@example.com",
  organization_id: "org-1",
  organization: {
    id: "org-1",
    name: "Test Org",
    is_active: true,
  },
  is_active: true,
  role: "admin",
  steward_user_id: "stwd-user-1",
  wallet_address: null,
  is_anonymous: false,
};

mock.module("@/lib/services/users", () => ({
  usersService: {
    getByStewardId: async (stewardId: string) =>
      stewardId === TEST_USER.steward_user_id ? TEST_USER : null,
  },
}));

async function signStewardToken(secret: string) {
  return new SignJWT({
    email: TEST_USER.email,
    tenantId: "elizacloud",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(TEST_USER.steward_user_id)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(secret));
}

function makeContext(token: string, env: Record<string, string | undefined>) {
  const state = new Map<string, unknown>();
  return {
    env,
    req: {
      header(name: string) {
        return name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined;
      },
    },
    get(key: string) {
      return state.get(key);
    },
    set(key: string, value: unknown) {
      state.set(key, value);
    },
  };
}

describe("workers-hono-auth Steward JWT verification", () => {
  test("prefers STEWARD_JWT_SECRET over legacy STEWARD_SESSION_SECRET when both are configured", async () => {
    const { getCurrentUser } = await import("@/lib/auth/workers-hono-auth");
    const token = await signStewardToken("canonical-jwt-secret");

    const user = await getCurrentUser(
      makeContext(token, {
        STEWARD_JWT_SECRET: "canonical-jwt-secret",
        STEWARD_SESSION_SECRET: "old-session-secret",
        STEWARD_TENANT_ID: "elizacloud",
      }) as never,
    );

    expect(user?.id).toBe(TEST_USER.id);
    expect(user?.organization_id).toBe(TEST_USER.organization_id);
  });

  test("falls back to STEWARD_SESSION_SECRET when STEWARD_JWT_SECRET is absent", async () => {
    const { getCurrentUser } = await import("@/lib/auth/workers-hono-auth");
    const token = await signStewardToken("legacy-session-secret");

    const user = await getCurrentUser(
      makeContext(token, {
        STEWARD_SESSION_SECRET: "legacy-session-secret",
        STEWARD_TENANT_ID: "elizacloud",
      }) as never,
    );

    expect(user?.id).toBe(TEST_USER.id);
  });
});
