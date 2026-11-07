/** Deterministic synthetic signed-envelope controls for canonical Shared Network admission. */
import { expect, test } from "bun:test";
import {
  isVerifiedNetworkAdmission,
  networkAccountMatchesPolicy,
  networkIngressMatchesPolicy,
  parseNetworkAdmissionPolicy,
  verifyNetworkAdmissionEnvelope,
  verifyNetworkHandledEnvelope,
  verifyNetworkOpenAdmission,
  verifyNetworkServiceDeliveryEnvelope,
} from "./network-shared-admission";

const policy = {
  phoneNumber: "+15555550100",
  project: "eliza-app" as const,
  platform: "blooio" as const,
  connectorAccountId: "owned-connector",
  messageIdPrefix: "blooio:eliza-app:",
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
};
const ingress = {
  project: "eliza-app",
  platform: "blooio" as const,
  connectorAccountId: "owned-connector",
  phoneNumber: "+15555550100",
  messageId: "blooio:eliza-app:provider-id",
  message: "hello",
};
test("Network ingress remains default off and matches exact existing connector namespace", () => {
  expect(networkIngressMatchesPolicy(ingress, policy, undefined)).toBe(false);
  expect(networkIngressMatchesPolicy(ingress, policy, "true")).toBe(true);
  for (const patch of [
    { project: "network" },
    { connectorAccountId: "other" },
    { messageId: "blooio:network:provider-id" },
  ])
    expect(networkIngressMatchesPolicy({ ...ingress, ...patch }, policy, "true")).toBe(false);
});
test("Network capability never substitutes another Cloud account or room", () => {
  const account = {
    userId: policy.userId,
    organizationId: policy.organizationId,
    agentId: "personal:canonical",
    roomId: "personal:canonical",
  };
  expect(networkAccountMatchesPolicy(account, policy)).toBe(true);
  expect(networkAccountMatchesPolicy({ ...account, userId: policy.organizationId }, policy)).toBe(
    false,
  );
  expect(networkAccountMatchesPolicy({ ...account, roomId: "other" }, policy)).toBe(false);
});
test("Malformed or widening Network policy grants no authority", () => {
  expect(parseNetworkAdmissionPolicy(JSON.stringify(policy))).toEqual(policy);
  for (const value of [
    { ...policy, project: "network" },
    { ...policy, extra: true },
    { ...policy, userId: "invalid" },
    { ...policy, userId: [policy.userId] },
    { ...policy, organizationId: [policy.organizationId] },
    null,
  ])
    expect(parseNetworkAdmissionPolicy(JSON.stringify(value))).toBeUndefined();
});

const path = "/api/internal/eliza-app/personal-shared/messages";
const secret = "synthetic-test-secret-never-production-123";
const handled = {
  request: {
    messageId: "provider-id",
    channel: "blooio",
    from: ingress.phoneNumber,
    to: null,
    text: "hello",
    transport: "imessage",
    receivedAt: 1,
  },
  response: {
    outcome: "handled",
    replies: ["Hello"],
    replyIds: ["reply-1"],
    delivery: "collected",
    replyKind: "reply",
    accountEligible: true,
    reason: "handled",
    app: "ntwrk",
    memberId: "member-1",
  },
};
async function signed(body: Record<string, unknown>, nowS?: number) {
  const originalBody = JSON.stringify({ transport: "imessage", ...body });
  const { svcSign } = await import("@elizaos/plugin-network/svc-auth");
  const signatureHeaders = await svcSign(secret, {
    method: "POST",
    path,
    id: "provider-id",
    body: originalBody,
    ...(nowS === undefined ? {} : { nowS }),
  });
  return { originalBody, path, signatureHeaders };
}
const bindings = {
  SERVICE_TURN_SECRET: secret,
  NETWORK_PERSONAL_CONTINUITY_ENABLED: "true",
  NETWORK_OWNED_INGRESS_POLICY: JSON.stringify(policy),
};
test("HANDLED signed envelope binds original sender text and collected outputs without minting OPEN authority", async () => {
  const envelope = await signed({ ...ingress, networkHandled: handled });
  const result = await verifyNetworkHandledEnvelope(envelope, bindings);
  expect(result?.handled.response.replyIds).toEqual(["reply-1"]);
  expect(isVerifiedNetworkAdmission(result)).toBe(false);
  expect(
    await verifyNetworkHandledEnvelope(
      {
        ...envelope,
        originalBody: envelope.originalBody.replace("Hello", "Changed"),
      },
      bindings,
    ),
  ).toBeUndefined();
});
test("HANDLED admission rejects stale signature, default off, crossed sender and simultaneous OPEN", async () => {
  expect(
    await verifyNetworkHandledEnvelope(
      await signed({ ...ingress, networkHandled: handled }, 1),
      bindings,
    ),
  ).toBeUndefined();
  expect(
    await verifyNetworkHandledEnvelope(await signed({ ...ingress, networkHandled: handled }), {
      ...bindings,
      NETWORK_PERSONAL_CONTINUITY_ENABLED: undefined,
    }),
  ).toBeUndefined();
  expect(
    await verifyNetworkHandledEnvelope(
      await signed({
        ...ingress,
        phoneNumber: "+15555550101",
        networkHandled: handled,
      }),
      bindings,
    ),
  ).toBeUndefined();
  expect(
    await verifyNetworkHandledEnvelope(
      await signed({ ...ingress, networkTurn: {}, networkHandled: handled }),
      bindings,
    ),
  ).toBeUndefined();
});
test("HANDLED admission rejects incomplete collected IDs and oversized replies", async () => {
  for (const response of [
    { ...handled.response, replyIds: [] },
    { ...handled.response, replies: ["x".repeat(1601)] },
    {
      ...handled.response,
      consent: { state: "opted_out", scope: "app", app: "wrong", at: 1 },
    },
  ])
    expect(
      await verifyNetworkHandledEnvelope(
        await signed({ ...ingress, networkHandled: { ...handled, response } }),
        bindings,
      ),
    ).toBeUndefined();
});

async function signedService(patch: Record<string, unknown> = {}, receipt = false) {
  const target = "/api/internal/network/deliver" + (receipt ? "/receipt" : "");
  const originalBody = JSON.stringify({
    id: "provider-id",
    to: ingress.phoneNumber,
    text: "queued reply",
    app: "ntwrk",
    memberId: "service-member",
    kind: "relay",
    ...patch,
  });
  const { svcSign } = await import("@elizaos/plugin-network/svc-auth");
  return {
    path: target,
    originalBody,
    signatureHeaders: await svcSign(secret, {
      method: "POST",
      path: target,
      id: "provider-id",
      body: originalBody,
    }),
  };
}
test("Service delivery and receipt use distinct exact signed paths and owned recipient scope", async () => {
  expect(
    (await verifyNetworkServiceDeliveryEnvelope(await signedService(), bindings))?.delivery.kind,
  ).toBe("relay");
  const receipt = await signedService({}, true);
  expect((await verifyNetworkServiceDeliveryEnvelope(receipt, bindings))?.delivery.to).toBe(
    ingress.phoneNumber,
  );
  expect(
    await verifyNetworkServiceDeliveryEnvelope(
      { ...receipt, path: "/api/internal/network/deliver" },
      bindings,
    ),
  ).toBeUndefined();
});
test("Service delivery rejects foreign recipient, channel, provider ID and unknown effect fields", async () => {
  for (const patch of [
    { to: "+15555550101" },
    { channel: "twilio" },
    { id: "different-id" },
    { networkTurn: {} },
  ])
    expect(
      await verifyNetworkServiceDeliveryEnvelope(await signedService(patch), bindings),
    ).toBeUndefined();
});

test("OPEN signed context mints only an in-memory capability and re-verifies across DO serialization", async () => {
  const turn = {
    channel: "blooio",
    app: "ntwrk",
    memberId: "service-member",
    messageId: "provider-id",
    context: {
      firstName: "Owned",
      city: null,
      state: "open",
      stateFrom: null,
      stateUntil: null,
      facets: [],
      activeItems: null,
      singlePlayer: false,
    },
  };
  const envelope = await signed({ ...ingress, networkTurn: turn });
  const admission = await verifyNetworkOpenAdmission({
    originalBody: envelope.originalBody,
    headers: new Headers(envelope.signatureHeaders),
    path,
    service: "webhook-gateway",
    secret,
    enabled: "true",
    policy,
    ingress: { ...ingress, transport: "rcs" },
    turn,
  });
  expect(isVerifiedNetworkAdmission(admission)).toBe(true);
  expect(admission?.ingress.transport).toBe("imessage");
  expect(isVerifiedNetworkAdmission(JSON.parse(JSON.stringify(admission)))).toBe(false);
  const reverified = await verifyNetworkAdmissionEnvelope(
    JSON.parse(JSON.stringify(envelope)),
    bindings,
  );
  expect(isVerifiedNetworkAdmission(reverified)).toBe(true);
  for (const transport of [undefined, "invalid", ["imessage"]]) {
    expect(
      await verifyNetworkAdmissionEnvelope(
        await signed({ ...ingress, networkTurn: turn, transport }),
        bindings,
      ),
    ).toBeUndefined();
  }
  expect(
    await verifyNetworkAdmissionEnvelope(
      {
        ...envelope,
        originalBody: envelope.originalBody.replace("Owned", "Forged"),
      },
      bindings,
    ),
  ).toBeUndefined();
});

// The account-free handled path must validate signed transport before any egress.
test("Canonical handled envelopes reject missing, invalid and contradictory transport", async () => {
  for (const transport of [undefined, "invalid", "sms"]) {
    expect(
      await verifyNetworkHandledEnvelope(
        await signed({ ...ingress, transport, networkHandled: handled }),
        bindings,
      ),
    ).toBeUndefined();
  }
});
