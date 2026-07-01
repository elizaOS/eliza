/**
 * PATCH /api/v1/user/email — defense-in-depth gate (#10272).
 *
 * This self-service route sets `email_verified = false` with NO ownership proof,
 * so it must NOT accept a privileged-domain (`@elizalabs.ai`) address: an
 * unverified admin-domain email is a super_admin grant vector. The route calls
 * `isElizaLabsAdminEmail` and returns 403 before touching the users table.
 *
 * The admin-grant logic itself (`isElizaLabsAdminEmail`, the verified-email
 * super_admin gate) is covered by
 * `packages/cloud/shared/src/lib/services/__tests__/admin-email.test.ts` — this
 * file asserts the ROUTE-level rejection, which did not exist before the fix.
 *
 * `bun:test`'s `mock.module` is hoisted-import-aware and process-global: register
 * mocks BEFORE importing the route module, and spread real modules so only the
 * exports this file shadows are replaced.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
// `mock.module` is process-global in Bun's single-process run: a PARTIAL mock of
// a shared module drops its other real exports for every later importer in the
// run. Spread the real modules so only the exports this file shadows are
// replaced (cf. users-me-wallet-attach.test.ts).
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";

const requireUserOrApiKey = mock<(c: unknown) => Promise<{ id: string }>>();
const getById =
  mock<(id: string) => Promise<{ email: string | null } | undefined>>();
const getByEmail =
  mock<(email: string) => Promise<{ id: string } | undefined>>();
const update =
  mock<(id: string, data: Record<string, unknown>) => Promise<unknown>>();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKey,
}));

mock.module("@/lib/services/users", () => ({
  usersService: { getById, getByEmail, update },
}));

// `@/lib/services/admin` is mocked to avoid pulling its DB-client graph (a real
// import hangs on connect at module load). `isElizaLabsAdminEmail` is a faithful
// copy of the real one-liner (admin.ts:
// `email?.trim().toLowerCase().endsWith("@elizalabs.ai")`); the real function and
// the super_admin grant gate are unit-tested in admin-email.test.ts. This keeps
// the route's WIRING (does it call the gate and return 403?) as the unit under
// test. Each cloud-api test file runs in its own process (test/run-unit-isolated.mjs),
// so this partial module override cannot leak into other files.
mock.module("@/lib/services/admin", () => ({
  isElizaLabsAdminEmail: (email?: string | null): boolean =>
    Boolean(email?.trim().toLowerCase().endsWith("@elizalabs.ai")),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

let emailRoute: { default: { fetch: (req: Request) => Promise<Response> } };

beforeAll(async () => {
  emailRoute = (await import("../v1/user/email/route")) as typeof emailRoute;
});

function patchEmail(email: string) {
  return new Request("http://test.local/", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

afterEach(() => {
  requireUserOrApiKey.mockReset();
  getById.mockReset();
  getByEmail.mockReset();
  update.mockReset();
});

describe("PATCH /api/v1/user/email — privileged-domain rejection", () => {
  test("rejects an @elizalabs.ai address with 403 and never writes it", async () => {
    requireUserOrApiKey.mockResolvedValue({ id: "user-1" });
    // User has no email yet (the only state where the route would otherwise set one).
    getById.mockResolvedValue({ email: null });

    const res = await emailRoute.default.fetch(
      patchEmail("attacker@elizalabs.ai"),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("cannot be set here");
    // The gate must fire BEFORE the uniqueness check and the write.
    expect(getByEmail).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test("rejects @elizalabs.ai case-insensitively (mixed case + padding)", async () => {
    requireUserOrApiKey.mockResolvedValue({ id: "user-1" });
    getById.mockResolvedValue({ email: null });

    const res = await emailRoute.default.fetch(
      patchEmail("ATTACKER@ELIZALABS.AI"),
    );

    expect(res.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  test("still allows a normal address through to the write", async () => {
    requireUserOrApiKey.mockResolvedValue({ id: "user-1" });
    getById.mockResolvedValue({ email: null });
    getByEmail.mockResolvedValue(undefined);
    update.mockResolvedValue(undefined);

    const res = await emailRoute.default.fetch(patchEmail("user@gmail.com"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(update).toHaveBeenCalledWith("user-1", {
      email: "user@gmail.com",
      email_verified: false,
    });
  });
});
