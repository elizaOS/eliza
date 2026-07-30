/**
 * Real-PGlite proof that affected-party approval prompts reach Discord users
 * as DMs. The household route targets the party's verified Discord USER id
 * with a typed `targetKind: "user"` payload (a raw channel-id send fails with
 * Unknown Channel), consults connector liveness so a dead higher-preference
 * telegram route cannot shadow a live discord route, and falls back to the
 * owner-relay `internal` channel when no connector can deliver. The connector
 * send is mocked at the ConnectorRegistry seam; the production default channel
 * pack registered by the plugin does the delegation.
 */
import { randomUUID } from "node:crypto";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { createApprovalQueue } from "../approval-queue.js";
import type { ConnectorSendPayload } from "../connectors/_helpers.js";
import {
  type ConnectorStatus,
  createConnectorRegistry,
  registerConnectorRegistry,
} from "../connectors/index.js";
import { createHouseholdCoordinationService } from "./service.js";
import {
  householdApprovalCommandText,
  householdApprovalRequestPrompt,
} from "./types.js";

describe("household discord party route — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  const discordSends: ConnectorSendPayload[] = [];
  let telegramSendAttempts = 0;

  function status(state: ConnectorStatus["state"]): ConnectorStatus {
    return { state, observedAt: new Date().toISOString() };
  }

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    await graph.getEntityStore(runtime.agentId).ensureSelf();
    // Replace the plugin's default connector pack with the registry seam under
    // test: a telegram connector that is registered but dead, and a discord
    // connector that is live and captures what the default-pack discord
    // channel delegates to it. The channel registry stays the production one.
    const connectors = createConnectorRegistry();
    connectors.register({
      kind: "telegram",
      capabilities: ["telegram.send"],
      modes: ["local"],
      describe: { label: "Telegram (dead)" },
      async start() {},
      async disconnect() {},
      async verify() {
        return false;
      },
      async status() {
        return status("disconnected");
      },
      async send() {
        telegramSendAttempts += 1;
        throw new Error(
          "The dead telegram connector must never receive a household send.",
        );
      },
    });
    connectors.register({
      kind: "discord",
      capabilities: ["discord.send"],
      modes: ["local"],
      describe: { label: "Discord (capture)" },
      async start() {},
      async disconnect() {},
      async verify() {
        return true;
      },
      async status() {
        return status("ok");
      },
      async send(payload) {
        discordSends.push(payload as ConnectorSendPayload);
        return { ok: true };
      },
    });
    registerConnectorRegistry(runtime, connectors);
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  async function person(input: {
    label: string;
    identities?: ReadonlyArray<{ platform: string; handle: string }>;
  }): Promise<string> {
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const now = new Date().toISOString();
    const entity = await graph.getEntityStore(runtime.agentId).upsert({
      entityId: `ent_${input.label}_${randomUUID()}`,
      type: "person",
      preferredName: input.label,
      identities: (input.identities ?? []).map((identity) => ({
        platform: identity.platform,
        handle: identity.handle,
        verified: true,
        confidence: 1,
        addedAt: now,
        addedVia: "import",
        evidence: ["connector identity verified by owner"],
      })),
      tags: ["household-discord-route-test"],
      visibility: "owner_only",
      state: {},
    });
    return entity.entityId;
  }

  async function pendingProposal(partyEntityId: string): Promise<{
    proposalId: string;
    proposalVersion: number;
    approvalRequestId: string;
  }> {
    const service = createHouseholdCoordinationService(runtime);
    const childEntityId = await person({ label: "child" });
    await service.bindRole({
      entityId: childEntityId,
      role: "child",
      subjectEntityIds: [childEntityId],
      boundByEntityId: SELF_ENTITY_ID,
      evidence: "Owner identified the child.",
    });
    await service.bindRole({
      entityId: partyEntityId,
      role: "co_parent",
      subjectEntityIds: [childEntityId],
      boundByEntityId: SELF_ENTITY_ID,
      evidence: "Owner identified the co-parent.",
    });
    const proposal = await service.createProposal({
      coordinationId: `coord_${randomUUID()}`,
      terms: {
        summary: "Friday pickup exchange",
        startAt: "2027-03-12T23:30:00.000Z",
        endAt: "2027-03-13T00:00:00.000Z",
        timezone: "America/Los_Angeles",
        childEntityIds: [childEntityId],
        location: null,
        notes: null,
        custodyException: null,
      },
      affectedPartyEntityIds: [partyEntityId],
      requiredApproverEntityIds: [partyEntityId],
      createdByEntityId: SELF_ENTITY_ID,
      expiresAt: "2027-03-10T00:00:00.000Z",
    });
    const approvals = await service.ensureProposalApprovals(
      proposal.proposalId,
      proposal.version,
    );
    const approval = approvals.find(
      (candidate) => candidate.partyEntityId === partyEntityId,
    );
    if (!approval) throw new Error("approval link unavailable");
    return {
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
      approvalRequestId: approval.approvalRequestId,
    };
  }

  it("delivers the party prompt as a user-typed discord DM target, past the dead telegram route", async () => {
    const discordUserId = "111111111111111111";
    const coParentId = await person({
      label: "discord-co-parent",
      identities: [
        // Telegram is the higher-preference route; its connector is dead, so
        // it must not shadow the live discord route.
        { platform: "telegram", handle: `tg-${randomUUID()}` },
        { platform: "discord", handle: discordUserId },
      ],
    });
    const pending = await pendingProposal(coParentId);

    expect(telegramSendAttempts).toBe(0);
    const delivered = discordSends.find(
      (send) => send.target === discordUserId,
    );
    if (!delivered) throw new Error("discord approval prompt not delivered");
    // The typed target is the party's Discord USER id — the same identity the
    // inbound authenticator matches (metadata.discord.userId) — so the reply
    // authenticates against the identity the prompt was delivered to.
    expect(delivered.targetKind).toBe("user");
    expect(delivered.message).toBe(
      householdApprovalRequestPrompt({
        approvalRequestId: pending.approvalRequestId,
        reason: `Approve household schedule proposal ${pending.proposalId} v${pending.proposalVersion}`,
      }),
    );
    expect(delivered.message).toContain(
      householdApprovalCommandText("approve", pending.approvalRequestId),
    );
    expect(delivered.metadata).toMatchObject({
      approvalRequestId: pending.approvalRequestId,
      partyEntityId: coParentId,
    });

    const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
    expect(
      await queue.byId(pending.approvalRequestId, coParentId),
    ).toMatchObject({
      channel: "discord",
      state: "pending",
    });
  });

  it("keeps the owner-relay internal fallback when every verified route is dead", async () => {
    const sendsBefore = discordSends.length;
    const coParentId = await person({
      label: "unroutable-co-parent",
      identities: [{ platform: "telegram", handle: `tg-${randomUUID()}` }],
    });
    const pending = await pendingProposal(coParentId);

    expect(telegramSendAttempts).toBe(0);
    expect(discordSends).toHaveLength(sendsBefore);
    const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
    expect(
      await queue.byId(pending.approvalRequestId, coParentId),
    ).toMatchObject({
      channel: "internal",
      state: "pending",
    });
  });
});
