/**
 * Route-level guard for ad-account approval/rejection (#11364).
 *
 * The shared service owns the state machine, but the money-path invariant that
 * an org owner cannot self-approve lives at the Hono route via `requireAdmin`.
 * Drive the real route so a regression to `requireUserOrApiKeyWithOrg` is caught
 * before any service transition can run.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ForbiddenError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { Hono } from "hono";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";

const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000ad";

const requireAdmin = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireAdmin,
}));

const approveAccount = mock();
const rejectAccount = mock();
mock.module("@/lib/services/advertising", () => ({
  advertisingService: {
    approveAccount,
    rejectAccount,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
}));

const { default: accountRoute } = await import(
  "../v1/advertising/accounts/[id]/route"
);

const app = new Hono();
app.route("/api/v1/advertising/accounts/:id", accountRoute);

function post(path: "approve" | "reject") {
  return app.request(`/api/v1/advertising/accounts/${ACCOUNT_ID}/${path}`, {
    method: "POST",
  });
}

beforeEach(() => {
  requireAdmin.mockReset();
  approveAccount.mockReset();
  rejectAccount.mockReset();
});

describe("advertising account approve/reject routes", () => {
  test("approve rejects a non-admin caller before touching the service", async () => {
    requireAdmin.mockRejectedValue(ForbiddenError("Admin access required"));

    const res = await post("approve");
    const body = (await res.json()) as { code?: string; error?: string };

    expect(res.status).toBe(403);
    expect(body).toMatchObject({
      code: "access_denied",
      error: "Admin access required",
    });
    expect(approveAccount).not.toHaveBeenCalled();
  });

  test("approve lets an admin transition the account", async () => {
    requireAdmin.mockResolvedValue({ user: { id: "admin-1" }, role: "admin" });
    approveAccount.mockResolvedValue({ id: ACCOUNT_ID, status: "active" });

    const res = await post("approve");
    const body = (await res.json()) as { id?: string; status?: string };

    expect(res.status).toBe(200);
    expect(body).toEqual({ id: ACCOUNT_ID, status: "active" });
    expect(approveAccount).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  test("reject is also admin-gated before touching the service", async () => {
    requireAdmin.mockRejectedValue(ForbiddenError("Admin access required"));

    const res = await post("reject");

    expect(res.status).toBe(403);
    expect(rejectAccount).not.toHaveBeenCalled();
  });
});
