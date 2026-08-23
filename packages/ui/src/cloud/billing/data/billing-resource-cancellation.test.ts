/** Contract tests for the strict cancellation mutation and receipt boundary. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiWithStatusMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api-client", () => ({
  apiWithStatus: apiWithStatusMock,
}));

import {
  readBillingCancellationReceipt,
  requestBillingCancellation,
} from "./billing-resource-cancellation";

const RESOURCE_ID = "11111111-1111-4111-8111-111111111111";
const RECEIPT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ENDPOINT = `/api/v1/billing/resources/${RESOURCE_ID}/cancel`;
const ENDPOINT = `${RECEIPT_ENDPOINT}?resourceType=container`;
const POLL_ENDPOINT = `${RECEIPT_ENDPOINT}?receiptId=${RECEIPT_ID}`;

function receipt(
  status:
    | "accepted"
    | "provider_confirmed"
    | "conflict"
    | "terminal_attention" = "accepted",
) {
  const projection = {
    accepted: {
      billingStopped: false,
      infrastructureStatus: "queued",
    },
    provider_confirmed: {
      billingStopped: true,
      infrastructureStatus: "provider_confirmed",
    },
    conflict: {
      billingStopped: false,
      infrastructureStatus: "superseded",
    },
    terminal_attention: {
      billingStopped: false,
      infrastructureStatus: "terminal_attention",
    },
  }[status];
  return {
    receiptId: RECEIPT_ID,
    jobId: JOB_ID,
    resourceType: "container",
    resourceId: RESOURCE_ID,
    action: "stop",
    expectedLifecycleRevision: 7,
    status,
    ...projection,
    acceptedAt: "2026-08-23T10:20:30.000Z",
    pollEndpoint: POLL_ENDPOINT,
  };
}

beforeEach(() => apiWithStatusMock.mockReset());

describe("requestBillingCancellation", () => {
  it("posts the server projection with the persistent idempotency key", async () => {
    apiWithStatusMock.mockResolvedValue({
      status: 202,
      data: {
        success: true,
        disposition: "accepted",
        receipt: receipt(),
      },
    });

    const result = await requestBillingCancellation({
      endpoint: ENDPOINT,
      resourceType: "container",
      resourceId: RESOURCE_ID,
      expectedLifecycleRevision: 7,
      idempotencyKey: "billing-cancel:test-key",
    });

    expect(result.receipt.status).toBe("accepted");
    expect(apiWithStatusMock).toHaveBeenCalledWith(ENDPOINT, {
      method: "POST",
      headers: { "Idempotency-Key": "billing-cancel:test-key" },
      json: {
        resourceType: "container",
        mode: "stop",
        expectedLifecycleRevision: 7,
      },
      signal: undefined,
    });
  });

  it("accepts the authoritative conflict receipt from HTTP 409", async () => {
    apiWithStatusMock.mockResolvedValue({
      status: 409,
      data: {
        success: false,
        disposition: "same_command",
        receipt: receipt("conflict"),
      },
    });

    const result = await requestBillingCancellation({
      endpoint: ENDPOINT,
      resourceType: "container",
      resourceId: RESOURCE_ID,
      expectedLifecycleRevision: 7,
      idempotencyKey: "billing-cancel:test-key",
    });
    expect(result.receipt.status).toBe("conflict");
  });

  it("surfaces an HTTP conflict without inventing a receipt", async () => {
    apiWithStatusMock.mockResolvedValue({
      status: 409,
      data: {
        success: false,
        code: "billing_state_conflict",
        error: "Lifecycle changed",
      },
    });

    await expect(
      requestBillingCancellation({
        endpoint: ENDPOINT,
        resourceType: "container",
        resourceId: RESOURCE_ID,
        expectedLifecycleRevision: 7,
        idempotencyKey: "billing-cancel:test-key",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "billing_state_conflict",
      retryable: false,
    });
  });

  it("rejects a receipt whose billingStopped claim contradicts status", async () => {
    apiWithStatusMock.mockResolvedValue({
      status: 202,
      data: {
        success: true,
        disposition: "accepted",
        receipt: { ...receipt(), billingStopped: true },
      },
    });

    await expect(
      requestBillingCancellation({
        endpoint: ENDPOINT,
        resourceType: "container",
        resourceId: RESOURCE_ID,
        expectedLifecycleRevision: 7,
        idempotencyKey: "billing-cancel:test-key",
      }),
    ).rejects.toThrow("Billing cancellation response is invalid.");
  });

  it("rejects a snapshot endpoint that does not match the resource", async () => {
    await expect(
      requestBillingCancellation({
        endpoint: "/api/v1/billing/resources/elsewhere/cancel",
        resourceType: "container",
        resourceId: RESOURCE_ID,
        expectedLifecycleRevision: 7,
        idempotencyKey: "billing-cancel:test-key",
      }),
    ).rejects.toThrow("Billing cancellation endpoint is invalid.");
    expect(apiWithStatusMock).not.toHaveBeenCalled();
  });
});

describe("readBillingCancellationReceipt", () => {
  it("reads a provider-confirmed business receipt from the exact poll URL", async () => {
    apiWithStatusMock.mockResolvedValue({
      status: 200,
      data: { success: true, receipt: receipt("provider_confirmed") },
    });

    const result = await readBillingCancellationReceipt(POLL_ENDPOINT, {
      resourceType: "container",
      resourceId: RESOURCE_ID,
      expectedLifecycleRevision: 7,
      receiptId: RECEIPT_ID,
    });
    expect(result).toMatchObject({
      status: "provider_confirmed",
      billingStopped: true,
      infrastructureStatus: "provider_confirmed",
    });
  });

  it("rejects cross-resource receipt substitution", async () => {
    apiWithStatusMock.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        receipt: {
          ...receipt(),
          resourceId: "44444444-4444-4444-8444-444444444444",
        },
      },
    });

    await expect(
      readBillingCancellationReceipt(POLL_ENDPOINT, {
        resourceType: "container",
        resourceId: RESOURCE_ID,
        expectedLifecycleRevision: 7,
        receiptId: RECEIPT_ID,
      }),
    ).rejects.toThrow("Billing cancellation response is invalid.");
  });
});
