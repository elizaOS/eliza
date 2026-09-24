/** Attacks receipt fabrication, replay, tenant isolation, and denial at the real fake-upstream boundary. */

import { afterEach, describe, expect, test } from "bun:test";
import { normalizeEffectReceipt } from "@elizaos/core";
import {
  type RunningFakeProvider,
  startFakeProvider,
} from "../../src/provider-contract";

const running: RunningFakeProvider[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((provider) => provider.stop()));
});

async function startActionProvider(): Promise<RunningFakeProvider> {
  const provider = await startFakeProvider({
    now: () => Date.parse("2026-08-18T00:00:00Z"),
    accounts: [
      {
        accountId: "acct-owner",
        tenantId: "org-owner",
        capabilities: ["items.write", "items.delete", "items.fail"],
        apiCredential: "owner-token",
      },
      {
        accountId: "acct-other",
        tenantId: "org-other",
        capabilities: ["items.write"],
        apiCredential: "other-token",
      },
    ],
    fixtures: [
      {
        id: "write",
        method: "POST",
        path: "/v1/items",
        action: {
          operation: "items.create",
          capabilityId: "items.write",
          effect: "write",
          riskLevel: "R1",
          decision: "allow",
          confirmation: { state: "not_required" },
        },
        response: { status: 201, body: { id: "item-1" } },
      },
      {
        id: "delete-confirmation",
        method: "DELETE",
        path: "/v1/items/item-confirmable",
        action: {
          operation: "items.delete",
          capabilityId: "items.delete",
          effect: "irreversible",
          riskLevel: "R3",
          decision: "allow",
          confirmation: {
            state: "required",
            confirmationId: "confirmation-delete-confirmable",
          },
        },
        response: { status: 204 },
      },
      {
        id: "delete-denied",
        method: "DELETE",
        path: "/v1/items/item-1",
        action: {
          operation: "items.delete",
          capabilityId: "items.delete",
          effect: "irreversible",
          riskLevel: "R3",
          decision: "deny",
          confirmation: {
            state: "required",
            confirmationId: "confirmation-delete-item-1",
          },
        },
        response: { status: 204 },
      },
      {
        id: "provider-failure",
        method: "POST",
        path: "/v1/fail",
        action: {
          operation: "items.fail",
          capabilityId: "items.fail",
          effect: "write",
          riskLevel: "R1",
          decision: "allow",
          confirmation: { state: "not_required" },
        },
        response: {
          status: 502,
          body: { error: { code: "upstream_rejected" } },
        },
      },
    ],
  });
  running.push(provider);
  return provider;
}

function actionHeaders(input: {
  token?: string;
  tenantId?: string;
  accountId?: string;
  requestId: string;
  idempotencyKey?: string;
  confirmationId?: string;
}): Record<string, string> {
  return {
    authorization: `Bearer ${input.token ?? "owner-token"}`,
    "content-type": "application/json",
    "x-organization-id": input.tenantId ?? "org-owner",
    "x-provider-account-id": input.accountId ?? "acct-owner",
    "x-provider-request-id": input.requestId,
    ...(input.idempotencyKey
      ? { "idempotency-key": input.idempotencyKey }
      : {}),
    ...(input.confirmationId
      ? { "x-provider-confirmation-id": input.confirmationId }
      : {}),
  };
}

describe("provider action authorization/effect boundary", () => {
  test("cannot fabricate receipts and binds a fresh applied effect atomically", async () => {
    const provider = await startActionProvider();
    expect("recordAction" in provider).toBe(false);
    expect(provider.receipts).toEqual([]);

    const response = await fetch(`${provider.url}/v1/items`, {
      method: "POST",
      headers: actionHeaders({
        requestId: "request-create-1",
        idempotencyKey: "create-item-1",
      }),
      body: JSON.stringify({ name: "one" }),
    });
    expect(response.status).toBe(201);
    const receipt = provider.receipts[0];
    expect(receipt).toMatchObject({
      tenantId: "org-owner",
      accountId: "acct-owner",
      capabilityId: "items.write",
      operation: "items.create",
      outcome: "succeeded",
      request: {
        id: "request-create-1",
        idempotencyKey: "create-item-1",
        replayOfReceiptId: null,
      },
      policy: {
        riskLevel: "R1",
        outcome: "allowed",
        confirmation: "not_required",
      },
      providerResult: { status: "accepted", resultId: "item-1" },
      executedEffect: { performed: true },
      effect: {
        outcome: "applied",
        commit: { kind: "provider_accepted", id: "item-1" },
      },
    });
    expect(receipt?.policyDecisionId).toBe(receipt?.policy.decisionId);
    expect(receipt && normalizeEffectReceipt(receipt.effect)).toEqual(
      receipt?.effect,
    );
    expect(provider.effects).toHaveLength(1);
    expect(response.headers.get("x-provider-receipt-id")).toBe(receipt?.id);
    if (receipt) receipt.outcome = "denied";
    expect(provider.receipts[0]?.outcome).toBe("succeeded");
  });

  test("replays an idempotent result without performing a second effect", async () => {
    const provider = await startActionProvider();
    const send = (requestId: string) =>
      fetch(`${provider.url}/v1/items`, {
        method: "POST",
        headers: actionHeaders({
          requestId,
          idempotencyKey: "create-item-1",
        }),
        body: JSON.stringify({ name: "one" }),
      });
    expect((await send("request-create-1")).status).toBe(201);
    expect((await send("request-create-retry")).status).toBe(201);
    expect(provider.effects).toHaveLength(1);
    expect(provider.receipts[1]).toMatchObject({
      outcome: "replayed",
      executedEffect: { performed: false, effectId: null },
      effect: {
        outcome: "noop",
        idempotency: { key: "create-item-1", replayed: true },
      },
    });
    expect(provider.receipts[1]?.request.replayOfReceiptId).toBe(
      provider.receipts[0]?.id,
    );

    const conflict = await fetch(`${provider.url}/v1/items`, {
      method: "POST",
      headers: actionHeaders({
        requestId: "request-conflict",
        idempotencyKey: "create-item-1",
      }),
      body: JSON.stringify({ name: "different" }),
    });
    expect(conflict.status).toBe(409);
    expect(provider.effects).toHaveLength(1);
    expect(provider.receipts[2]).toMatchObject({
      outcome: "denied",
      policy: { reasonCode: "idempotency_conflict" },
      providerResult: { status: "not_sent" },
      effect: { outcome: "failed" },
    });
  });

  test("cross-tenant and provider-policy denials prove zero upstream effect", async () => {
    const provider = await startActionProvider();
    const crossTenant = await fetch(`${provider.url}/v1/items`, {
      method: "POST",
      headers: actionHeaders({
        requestId: "request-cross-tenant",
        tenantId: "org-other",
      }),
      body: JSON.stringify({ name: "blocked" }),
    });
    expect(crossTenant.status).toBe(403);
    expect(provider.effects).toHaveLength(0);
    expect(provider.receipts[0]).toMatchObject({
      tenantId: "org-owner",
      accountId: "acct-owner",
      policy: { outcome: "denied", reasonCode: "cross_tenant" },
      providerResult: { status: "not_sent", resultId: null, digest: null },
      executedEffect: { performed: false, effectId: null },
      effect: {
        outcome: "failed",
        failure: { acceptance: "rejected" },
      },
    });

    const denied = await fetch(`${provider.url}/v1/items/item-1`, {
      method: "DELETE",
      headers: actionHeaders({
        requestId: "request-delete",
        confirmationId: "confirmation-delete-item-1",
      }),
    });
    expect(denied.status).toBe(403);
    expect(provider.effects).toHaveLength(0);
    expect(provider.receipts[1]).toMatchObject({
      effectKind: "irreversible",
      policy: {
        riskLevel: "R3",
        outcome: "denied",
        confirmation: "confirmed",
        reasonCode: "policy_denied",
      },
      providerResult: { status: "not_sent" },
      executedEffect: { performed: false },
    });
  });

  test("a required confirmation cannot be omitted before an irreversible effect", async () => {
    const provider = await startActionProvider();
    const missingConfirmation = await fetch(
      `${provider.url}/v1/items/item-confirmable`,
      {
        method: "DELETE",
        headers: actionHeaders({ requestId: "request-delete-unconfirmed" }),
      },
    );
    expect(missingConfirmation.status).toBe(409);
    expect(provider.effects).toHaveLength(0);
    expect(provider.receipts[0]).toMatchObject({
      effectKind: "irreversible",
      policy: {
        riskLevel: "R3",
        outcome: "denied",
        confirmation: "missing",
        confirmationId: "confirmation-delete-confirmable",
        reasonCode: "confirmation_required",
      },
      providerResult: { status: "not_sent" },
      executedEffect: { performed: false, effectId: null },
      effect: {
        outcome: "failed",
        failure: { code: "confirmation_required", acceptance: "rejected" },
      },
    });
  });

  test("an allowed policy with provider rejection emits failed proof and no effect", async () => {
    const provider = await startActionProvider();
    const response = await fetch(`${provider.url}/v1/fail`, {
      method: "POST",
      headers: actionHeaders({ requestId: "request-provider-failure" }),
      body: JSON.stringify({ value: 1 }),
    });
    expect(response.status).toBe(502);
    expect(provider.effects).toHaveLength(0);
    expect(provider.receipts[0]).toMatchObject({
      outcome: "failed",
      policy: { outcome: "allowed" },
      providerResult: { status: "rejected", statusCode: 502 },
      executedEffect: { performed: false, effectId: null },
      effect: {
        outcome: "failed",
        failure: {
          code: "provider_http_502",
          retryable: true,
          acceptance: "rejected",
        },
      },
    });
    expect(provider.receipts[0]?.providerResult.digest).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});
