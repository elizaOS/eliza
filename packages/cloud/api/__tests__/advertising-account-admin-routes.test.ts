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
const setAccountSpendCap = mock();
mock.module("@/lib/services/advertising", () => ({
  advertisingService: {
    approveAccount,
    rejectAccount,
    setAccountSpendCap,
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
  setAccountSpendCap.mockReset();

  requireAdmin.mockResolvedValue({ userId: "admin-1", role: "admin" });
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: "user-1",
    organization_id: "org-1",
    role: "admin",
  });
  approveAccount.mockResolvedValue({ id: ACCOUNT_ID, status: "active" });
  rejectAccount.mockResolvedValue({ id: ACCOUNT_ID, status: "suspended" });
  setAccountSpendCap.mockResolvedValue({
    id: ACCOUNT_ID,
    status: "active",
    spend_cap_credits: "250.00",
    updated_at: new Date("2026-07-03T00:00:00.000Z"),
  });
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

  test("owner or org admin can update an account spend cap", async () => {
    const response = await app.request(
      `/api/v1/advertising/accounts/${ACCOUNT_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({ spendCapCredits: 250 }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: ACCOUNT_ID,
      status: "active",
      spendCapCredits: "250.00",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    expect(setAccountSpendCap).toHaveBeenCalledWith(ACCOUNT_ID, "org-1", 250);
  });

  test("member cannot update account spend caps", async () => {
    requireUserOrApiKeyWithOrg.mockResolvedValue({
      id: "user-1",
      organization_id: "org-1",
      role: "member",
    });

    const response = await app.request(
      `/api/v1/advertising/accounts/${ACCOUNT_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({ spendCapCredits: 250 }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(response.status).toBe(403);
    expect(setAccountSpendCap).not.toHaveBeenCalled();
  });

  test("empty cap patch is rejected instead of clearing the cap implicitly", async () => {
    const response = await app.request(
      `/api/v1/advertising/accounts/${ACCOUNT_ID}`,
      {
        method: "PATCH",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );

    expect(response.status).toBe(400);
    expect(setAccountSpendCap).not.toHaveBeenCalled();
  });
});
