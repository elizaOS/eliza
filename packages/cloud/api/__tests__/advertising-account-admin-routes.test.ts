import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000aa";

const requireAdmin = mock();
const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireAdmin,
  requireUserOrApiKeyWithOrg,
}));

const approveAccount = mock();
const rejectAccount = mock();
mock.module("@/lib/services/advertising", () => ({
  advertisingService: {
    approveAccount,
    rejectAccount,
  },
}));

const { default: accountRoute } = await import(
  "../v1/advertising/accounts/[id]/route"
);

const app = new Hono();
app.route("/api/v1/advertising/accounts/:id", accountRoute);

beforeEach(() => {
  requireAdmin.mockReset();
  requireUserOrApiKeyWithOrg.mockReset();
  approveAccount.mockReset();
  rejectAccount.mockReset();

  requireAdmin.mockResolvedValue({ userId: "admin-1", role: "admin" });
  approveAccount.mockResolvedValue({ id: ACCOUNT_ID, status: "active" });
  rejectAccount.mockResolvedValue({ id: ACCOUNT_ID, status: "suspended" });
});

describe("advertising account admin routes", () => {
  test("approve requires admin and approves the requested account", async () => {
    const response = await app.request(
      `/api/v1/advertising/accounts/${ACCOUNT_ID}/approve`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: ACCOUNT_ID,
      status: "active",
    });
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(approveAccount).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  test("reject requires admin and suspends the requested account", async () => {
    const response = await app.request(
      `/api/v1/advertising/accounts/${ACCOUNT_ID}/reject`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: ACCOUNT_ID,
      status: "suspended",
    });
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(rejectAccount).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  test("non-admin approve request never reaches the service", async () => {
    requireAdmin.mockRejectedValue(
      new HTTPException(403, { message: "requires admin" }),
    );

    const response = await app.request(
      `/api/v1/advertising/accounts/${ACCOUNT_ID}/approve`,
      { method: "POST" },
    );

    expect(response.status).toBe(403);
    expect(approveAccount).not.toHaveBeenCalled();
  });

  test("non-admin reject request never reaches the service", async () => {
    requireAdmin.mockRejectedValue(
      new HTTPException(403, { message: "requires admin" }),
    );

    const response = await app.request(
      `/api/v1/advertising/accounts/${ACCOUNT_ID}/reject`,
      { method: "POST" },
    );

    expect(response.status).toBe(403);
    expect(rejectAccount).not.toHaveBeenCalled();
  });
});
