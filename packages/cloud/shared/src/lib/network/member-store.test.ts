/** Synthetic service-admission and canonical identity controls; no provider or state-store calls. */
import { expect, test } from "bun:test";
import type { NetworkStore } from "@elizaos/plugin-network";
import { svcSign } from "@elizaos/plugin-network/svc-auth";
import { verifyNetworkAdmissionEnvelope } from "../services/shared-runtime/network-shared-admission";
import { personalSharedAgentId } from "../services/shared-runtime/personal-shared-identity";
import { serviceNetworkStoreFactory, sharedNetworkExecution } from "./member-store";

const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const agent = {
  id: personalSharedAgentId({ userId, organizationId }),
  user_id: userId,
  organization_id: organizationId,
  execution_tier: "shared" as const,
};
const turn = {
  channel: "blooio",
  app: "ntwrk",
  memberId: "service-member",
  messageId: "provider-id",
  context: {
    firstName: "Synthetic",
    city: null,
    state: "open",
    stateFrom: null,
    stateUntil: null,
    facets: [],
    activeItems: null,
    singlePlayer: false,
  },
};
const secret = "synthetic-test-secret-never-production-123";
async function admission() {
  const path = "/api/internal/eliza-app/personal-shared/messages";
  const originalBody = JSON.stringify({
    project: "eliza-app",
    platform: "blooio",
    transport: "imessage",
    connectorAccountId: "owned-connector",
    phoneNumber: "+15555550100",
    messageId: "blooio:eliza-app:provider-id",
    message: "hello",
    networkTurn: turn,
  });
  return verifyNetworkAdmissionEnvelope(
    {
      path,
      originalBody,
      signatureHeaders: await svcSign(secret, {
        method: "POST",
        path,
        id: "provider-id",
        body: originalBody,
      }),
    },
    {
      SERVICE_TURN_SECRET: secret,
      NETWORK_PERSONAL_CONTINUITY_ENABLED: "true",
      NETWORK_OWNED_INGRESS_POLICY: JSON.stringify({
        project: "eliza-app",
        platform: "blooio",
        connectorAccountId: "owned-connector",
        phoneNumber: "+15555550100",
        messageIdPrefix: "blooio:eliza-app:",
        userId,
        organizationId,
      }),
    },
  );
}
test("Canonical admission is branded and service-backed without changing legacy project scope", async () => {
  const verified = await admission();
  expect(verified).toBeDefined();
  const env = {
    NETWORK_SERVICE_URL: "https://network.invalid",
    SERVICE_TURN_SECRET: secret,
  };
  expect(serviceNetworkStoreFactory(verified, env)?.app).toBe("ntwrk");
  expect(serviceNetworkStoreFactory(JSON.parse(JSON.stringify(verified)), env)).toBeUndefined();
  expect(serviceNetworkStoreFactory(turn, env)?.app).toBeUndefined();
  let calls = 0;
  const factory = Object.assign(
    () => {
      calls++;
      return {} as NetworkStore;
    },
    { app: "ntwrk" as const },
  );
  expect(
    sharedNetworkExecution(agent, true, false, factory, undefined, undefined, verified)?.memberId,
  ).toBe(userId);
  expect(calls).toBe(1);
  for (const [candidate, personal, wrongRoom] of [
    [agent, false, false],
    [agent, true, true],
    [{ ...agent, id: "other" }, true, false],
  ] as const) {
    expect(
      sharedNetworkExecution(
        candidate,
        personal,
        wrongRoom,
        factory,
        undefined,
        undefined,
        verified,
      ),
    ).toBeUndefined();
  }
  expect(sharedNetworkExecution(agent, true, false, factory)).toBeUndefined();
  expect(
    sharedNetworkExecution({ ...agent, project: "network" }, true, false, factory),
  ).toBeDefined();
  expect(
    sharedNetworkExecution(
      agent,
      true,
      false,
      Object.assign(
        () => {
          throw new Error("wrong-app factory must not run");
        },
        { app: "slop" as const },
      ),
      undefined,
      undefined,
      verified,
    ),
  ).toBeUndefined();
  expect(calls).toBe(2);
});
