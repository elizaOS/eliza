/**
 * Proves the billable-resource cancellation route reaches its effect only
 * after the current OWNER/ADMIN session boundary authorizes the exact tenant.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";

const requireCurrentBillingManagerSession = mock();
const requestCancellation = mock();
const resolveCancellationTarget = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireCurrentBillingManagerSession,
}));

mock.module("@/lib/services/active-billing", () => ({
  activeBillingService: { requestCancellation, resolveCancellationTarget },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  moneyRateLimit:
    () =>
    async (_context: unknown, next: () => Promise<void>): Promise<void> =>
      await next(),
  RateLimitPresets: { STANDARD: {} },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), warn: mock(), info: mock(), debug: mock() },
}));

const { default: route } = await import("./route");
const app = new Hono();
app.route("/api/v1/billing/resources/:id/cancel", route);

beforeEach(() => {
  requireCurrentBillingManagerSession.mockReset();
  requestCancellation.mockReset();
  resolveCancellationTarget.mockReset();
  resolveCancellationTarget.mockResolvedValue({
    resourceType: "container",
    lifecycleRevision: 7,
  });
  requestCancellation.mockResolvedValue({
    disposition: "accepted",
    receipt: {
      receiptId: "00000000-0000-4000-8000-000000000002",
      jobId: "00000000-0000-4000-8000-000000000003",
      resourceId: "00000000-0000-4000-8000-000000000001",
      resourceType: "container",
      action: "stop",
      expectedLifecycleRevision: 7,
      status: "accepted",
      computeStopped: false,
      providerStopped: false,
      retainedBackupBilling: { status: "not_applicable", ratePerHour: null },
      infrastructureStatus: "queued",
      acceptedAt: "2026-08-23T00:00:00.000Z",
      pollEndpoint: "/api/v1/jobs/00000000-0000-4000-8000-000000000003",
    },
  });
});

describe("billing resource cancellation authorization", () => {
  test("normalizes the published empty-body and delete contracts to durable stops", async () => {
    requireCurrentBillingManagerSession.mockResolvedValue({
      id: "owner-1",
      organization_id: "org-current",
      role: "owner",
      steward_id: "steward-owner",
    });

    const requests: RequestInit[] = [
      { method: "POST" },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "delete" }),
      },
    ];
    const payloads: unknown[] = [];
    for (const init of requests) {
      const response = await app.request(
        "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel",
        init,
      );
      expect(response.status).toBe(202);
      expect(response.headers.get("Deprecation")).toBe("true");
      expect(response.headers.get("X-Eliza-Billing-Cancel-Version")).toBe("2");
      expect(response.headers.get("Warning")).toContain(
        "Legacy billing cancellation request normalized",
      );
      payloads.push(await response.json());
    }

    expect(resolveCancellationTarget).toHaveBeenCalledTimes(2);
    expect(resolveCancellationTarget).toHaveBeenNthCalledWith(
      1,
      "org-current",
      "00000000-0000-4000-8000-000000000001",
      undefined,
    );
    expect(requestCancellation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        resourceType: "container",
        expectedLifecycleRevision: 7,
        idempotencyKey:
          "billing-cancel-compat:container:00000000-0000-4000-8000-000000000001:7",
      }),
    );
    expect(requestCancellation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        resourceType: "container",
        expectedLifecycleRevision: 7,
        idempotencyKey:
          "billing-cancel-compat:container:00000000-0000-4000-8000-000000000001:7",
      }),
    );
    expect(payloads[1]).toMatchObject({
      compatibility: {
        requestedMode: "delete",
        deletionPerformed: false,
        effectiveRequest: { mode: "stop" },
      },
    });
  });

  test("replays a lost acknowledgement but rotates the compatibility command after resume", async () => {
    requireCurrentBillingManagerSession.mockResolvedValue({
      id: "owner-1",
      organization_id: "org-current",
      role: "owner",
      steward_id: "steward-owner",
    });
    resolveCancellationTarget
      // Initial running generation N.
      .mockResolvedValueOnce({
        resourceType: "container",
        lifecycleRevision: 7,
      })
      // The provider-confirmed stop advanced the row to N+1, but proof
      // reconciliation preserves the effective cancellation generation N.
      .mockResolvedValueOnce({
        resourceType: "container",
        lifecycleRevision: 7,
      })
      // Resume advances the row again and starts a genuinely new command.
      .mockResolvedValueOnce({
        resourceType: "container",
        lifecycleRevision: 9,
      });
    const commands = new Map<
      string,
      { receiptId: string; jobId: string; expectedLifecycleRevision: number }
    >();
    requestCancellation.mockImplementation(async (options) => {
      const existing = commands.get(options.idempotencyKey);
      if (existing) {
        return {
          disposition: "same_key_replay",
          receipt: {
            ...existing,
            resourceId: options.resourceId,
            resourceType: options.resourceType,
            action: "stop",
            status: "provider_confirmed",
            computeStopped: true,
            providerStopped: true,
            retainedBackupBilling: {
              status: "not_applicable",
              ratePerHour: null,
            },
            infrastructureStatus: "provider_confirmed",
            acceptedAt: "2026-08-23T00:00:00.000Z",
            pollEndpoint: `/api/v1/jobs/${existing.jobId}`,
          },
        };
      }
      const commandNumber = commands.size * 2 + 2;
      const command = {
        receiptId: `00000000-0000-4000-8000-${commandNumber.toString().padStart(12, "0")}`,
        jobId: `00000000-0000-4000-8000-${(commandNumber + 1).toString().padStart(12, "0")}`,
        expectedLifecycleRevision: options.expectedLifecycleRevision,
      };
      commands.set(options.idempotencyKey, command);
      return {
        disposition: "accepted",
        receipt: {
          ...command,
          resourceId: options.resourceId,
          resourceType: options.resourceType,
          action: "stop",
          status: "accepted",
          computeStopped: false,
          providerStopped: false,
          retainedBackupBilling: {
            status: "not_applicable",
            ratePerHour: null,
          },
          infrastructureStatus: "queued",
          acceptedAt: "2026-08-23T00:00:00.000Z",
          pollEndpoint: `/api/v1/jobs/${command.jobId}`,
        },
      };
    });

    const payloads: Array<{
      disposition: string;
      receipt: {
        receiptId: string;
        jobId: string;
        expectedLifecycleRevision: number;
      };
    }> = [];
    for (const expectedStatus of [202, 200, 202]) {
      const response = await app.request(
        "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel",
        { method: "POST" },
      );
      expect(response.status).toBe(expectedStatus);
      payloads.push(await response.json());
    }

    expect(resolveCancellationTarget).toHaveBeenCalledTimes(3);
    for (const [index, expectedLifecycleRevision] of [7, 7, 9].entries()) {
      expect(requestCancellation).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          resourceType: "container",
          expectedLifecycleRevision,
          idempotencyKey: `billing-cancel-compat:container:00000000-0000-4000-8000-000000000001:${expectedLifecycleRevision}`,
        }),
      );
    }
    expect(payloads[1]).toMatchObject({
      disposition: "same_key_replay",
      receipt: {
        receiptId: payloads[0]!.receipt.receiptId,
        jobId: payloads[0]!.receipt.jobId,
        expectedLifecycleRevision: 7,
      },
    });
    expect(payloads[2]!.receipt.receiptId).not.toBe(
      payloads[0]!.receipt.receiptId,
    );
    expect(payloads[2]!.receipt.jobId).not.toBe(payloads[0]!.receipt.jobId);
    expect(payloads[2]!.receipt.expectedLifecycleRevision).toBe(9);
  });

  test("rejects malformed, whitespace, and non-object JSON before any effect", async () => {
    const invalidBodies = [
      ['{"resourceType":', "Cancellation body must be valid JSON"],
      ["   ", "Cancellation body must be valid JSON"],
      ["null", "Cancellation body must be a JSON object"],
      ["[]", "Cancellation body must be a JSON object"],
      ['"container"', "Cancellation body must be a JSON object"],
      ["7", "Cancellation body must be a JSON object"],
    ] as const;

    for (const [body, error] of invalidBodies) {
      const response = await app.request(
        "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ success: false, error });
    }

    expect(requireCurrentBillingManagerSession).not.toHaveBeenCalled();
    expect(resolveCancellationTarget).not.toHaveBeenCalled();
    expect(requestCancellation).not.toHaveBeenCalled();
  });

  test("keeps version 2 strict when target fields or idempotency are absent", async () => {
    requireCurrentBillingManagerSession.mockResolvedValue({
      id: "owner-1",
      organization_id: "org-current",
      role: "owner",
      steward_id: "steward-owner",
    });

    const emptyResponse = await app.request(
      "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel?type=container&expectedLifecycleRevision=7&mode=stop",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "billing-cancel-request-query-bypass",
          "X-Eliza-Billing-Cancel-Version": "2",
        },
      },
    );
    expect(emptyResponse.status).toBe(400);
    expect(requireCurrentBillingManagerSession).not.toHaveBeenCalled();
    expect(resolveCancellationTarget).not.toHaveBeenCalled();
    expect(requestCancellation).not.toHaveBeenCalled();

    requestCancellation.mockImplementation(async (options) => {
      if (options.idempotencyKey === "") {
        throw new ApiError(
          400,
          "validation_error",
          "A valid Idempotency-Key header is required for billing cancellation",
        );
      }
      throw new Error(
        "Expected the version-2 route to forward an empty idempotency key",
      );
    });
    const missingKeyResponse = await app.request(
      "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Eliza-Billing-Cancel-Version": "2",
        },
        body: JSON.stringify({
          resourceType: "container",
          mode: "stop",
          expectedLifecycleRevision: 7,
        }),
      },
    );
    expect(missingKeyResponse.status).toBe(400);
    expect(requestCancellation).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "" }),
    );
  });

  test("fails closed when an untyped target is ambiguous", async () => {
    requireCurrentBillingManagerSession.mockResolvedValue({
      id: "owner-1",
      organization_id: "org-current",
      role: "owner",
      steward_id: "steward-owner",
    });
    resolveCancellationTarget.mockRejectedValue(
      new ApiError(
        409,
        "billing_state_conflict",
        "Resource id is ambiguous; retry with resourceType",
      ),
    );

    const response = await app.request(
      "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel",
      { method: "POST" },
    );

    expect(response.status).toBe(409);
    expect(requestCancellation).not.toHaveBeenCalled();
  });

  test("uses the freshly authorized organization at the final effect boundary", async () => {
    const revalidatedStewardUserIds: string[] = [];
    requestCancellation.mockImplementation(async (options) => {
      revalidatedStewardUserIds.push(
        await options.authorizeInfrastructureMutation(),
      );
      return {
        disposition: "accepted",
        receipt: {
          receiptId: "00000000-0000-4000-8000-000000000002",
          jobId: "00000000-0000-4000-8000-000000000003",
          resourceId: "00000000-0000-4000-8000-000000000001",
          resourceType: "container",
          action: "stop",
          expectedLifecycleRevision: 7,
          status: "accepted",
          computeStopped: false,
          providerStopped: false,
          retainedBackupBilling: {
            status: "not_applicable",
            ratePerHour: null,
          },
          infrastructureStatus: "queued",
          acceptedAt: "2026-08-23T00:00:00.000Z",
          pollEndpoint: "/api/v1/jobs/00000000-0000-4000-8000-000000000003",
        },
      };
    });
    for (const role of ["owner", "admin"]) {
      requireCurrentBillingManagerSession.mockResolvedValue({
        id: `${role}-1`,
        organization_id: "org-current",
        role,
        steward_id: `steward-${role}`,
      });

      const response = await app.request(
        "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "billing-cancel-request-0001",
            "X-Eliza-Billing-Cancel-Version": "2",
          },
          body: JSON.stringify({
            resourceType: "container",
            mode: "stop",
            expectedLifecycleRevision: 7,
          }),
        },
      );

      expect(response.status).toBe(202);
    }

    expect(requestCancellation).toHaveBeenCalledTimes(2);
    expect(requireCurrentBillingManagerSession).toHaveBeenCalledTimes(4);
    expect(revalidatedStewardUserIds).toEqual([
      "steward-owner",
      "steward-admin",
    ]);
    expect(requestCancellation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        organizationId: "org-current",
        requestedByUserId: "owner-1",
        resourceId: "00000000-0000-4000-8000-000000000001",
        resourceType: "container",
        expectedLifecycleRevision: 7,
        idempotencyKey: "billing-cancel-request-0001",
      }),
    );
  });

  test("makes zero cancellation calls when current authority denies", async () => {
    for (const status of [401, 403, 503]) {
      requireCurrentBillingManagerSession.mockRejectedValueOnce(
        new ApiError(
          status,
          status === 401
            ? "session_auth_required"
            : status === 403
              ? "access_denied"
              : "service_unavailable",
          "denied",
        ),
      );
      const response = await app.request(
        "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "billing-cancel-request-0001",
            "X-Eliza-Billing-Cancel-Version": "2",
          },
          body: JSON.stringify({
            resourceType: "container",
            mode: "stop",
            expectedLifecycleRevision: 7,
          }),
        },
      );
      expect(response.status).toBe(status);
    }

    expect(requestCancellation).not.toHaveBeenCalled();
  });

  test("returns 400 when Idempotency-Key is missing", async () => {
    requireCurrentBillingManagerSession.mockResolvedValue({
      id: "owner-1",
      organization_id: "org-current",
      role: "owner",
      steward_id: "steward-owner",
    });
    requestCancellation.mockImplementation(async (options) => {
      if (options.idempotencyKey === "") {
        throw new ApiError(
          400,
          "validation_error",
          "A valid Idempotency-Key header is required for billing cancellation",
        );
      }
      throw new Error("Expected the route to forward an empty idempotency key");
    });

    const response = await app.request(
      "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Eliza-Billing-Cancel-Version": "2",
        },
        body: JSON.stringify({
          resourceType: "container",
          mode: "stop",
          expectedLifecycleRevision: 7,
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(requestCancellation).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "" }),
    );
  });

  test("preserves terminal-attention as a versioned 424 receipt", async () => {
    requireCurrentBillingManagerSession.mockResolvedValue({
      id: "owner-1",
      organization_id: "org-current",
      role: "owner",
      steward_id: "steward-owner",
    });
    requestCancellation.mockResolvedValue({
      disposition: "same_key_replay",
      receipt: {
        status: "terminal_attention",
        receiptId: "00000000-0000-4000-8000-000000000002",
      },
    });

    const response = await app.request(
      "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "billing-cancel-request-0001",
          "X-Eliza-Billing-Cancel-Version": "2",
        },
        body: JSON.stringify({
          resourceType: "container",
          mode: "stop",
          expectedLifecycleRevision: 7,
        }),
      },
    );

    expect(response.status).toBe(424);
    expect(response.headers.get("X-Eliza-Billing-Cancel-Version")).toBe("2");
    expect(await response.json()).toMatchObject({
      success: false,
      receipt: { status: "terminal_attention" },
    });
  });
});
