/**
 * Tier-upgrade handoff leg (#15355): the shared-bridge delete fires ONLY on a
 * confirmed switch, the outcome reports the delete result instead of
 * swallowing it, and handoff args are wired for the shared source (adapter
 * base + canonical conversation id). Client methods are doubled — the real
 * handoff stack is exercised end to end by the cloud-e2e upgrade spec.
 */

import { describe, expect, it, vi } from "vitest";
import type { ConversationHandoffResult } from "./conversation-handoff";
import {
  runSharedToDedicatedUpgradeHandoff,
  type TierUpgradeHandoffClient,
} from "./start-tier-upgrade";

const SHARED_ID = "11111111-1111-4111-8111-111111111111";
const DEDICATED_ID = "22222222-2222-4222-8222-222222222222";
const CLOUD_BASE = "https://api.cloud.test";
const TOKEN = "steward-token";

function makeClient(
  handoff: ConversationHandoffResult,
  deletion: { success: boolean; error?: string } = { success: true },
) {
  const startCloudAgentHandoff = vi.fn(
    async (options: {
      onSwitch: (base: string) => void | Promise<void>;
    }): Promise<ConversationHandoffResult> => {
      if (
        handoff.status === "switched" ||
        handoff.status === "switched-empty"
      ) {
        await options.onSwitch(`https://${DEDICATED_ID}.cloud.test`);
      }
      return handoff;
    },
  );
  const deleteSharedBridgeAgent = vi.fn(async () => deletion);
  const client = {
    startCloudAgentHandoff,
    deleteSharedBridgeAgent,
  } as unknown as TierUpgradeHandoffClient;
  return { client, startCloudAgentHandoff, deleteSharedBridgeAgent };
}

describe("runSharedToDedicatedUpgradeHandoff", () => {
  it("switch → import reported, shared bridge deleted, onSwitch fired with the container base", async () => {
    const { client, startCloudAgentHandoff, deleteSharedBridgeAgent } =
      makeClient({ status: "switched", imported: 4 });
    const onSwitch = vi.fn();

    const outcome = await runSharedToDedicatedUpgradeHandoff({
      sharedAgentId: SHARED_ID,
      dedicatedAgentId: DEDICATED_ID,
      cloudApiBase: CLOUD_BASE,
      authToken: TOKEN,
      client,
      onSwitch,
    });

    expect(outcome).toEqual({
      status: "switched",
      imported: 4,
      sharedBridgeDeleted: true,
    });
    expect(onSwitch).toHaveBeenCalledWith(`https://${DEDICATED_ID}.cloud.test`);
    // The handoff must target the SHARED adapter base + canonical conversation
    // id — the migration source — and poll the DEDICATED record for readiness.
    expect(startCloudAgentHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: SHARED_ID,
        dedicatedAgentId: DEDICATED_ID,
        conversationId: SHARED_ID,
        sharedApiBase: `${CLOUD_BASE}/api/v1/eliza/agents/${SHARED_ID}`,
        cloudApiBase: CLOUD_BASE,
        authToken: TOKEN,
      }),
    );
    expect(deleteSharedBridgeAgent).toHaveBeenCalledWith(SHARED_ID, {
      cloudApiBase: CLOUD_BASE,
      authToken: TOKEN,
    });
  });

  it("switched-empty (nothing to copy) still deletes the shared bridge", async () => {
    const { client, deleteSharedBridgeAgent } = makeClient({
      status: "switched-empty",
      imported: 0,
    });

    const outcome = await runSharedToDedicatedUpgradeHandoff({
      sharedAgentId: SHARED_ID,
      dedicatedAgentId: DEDICATED_ID,
      cloudApiBase: CLOUD_BASE,
      authToken: TOKEN,
      client,
    });

    expect(outcome.status).toBe("switched-empty");
    expect(outcome.sharedBridgeDeleted).toBe(true);
    expect(deleteSharedBridgeAgent).toHaveBeenCalledTimes(1);
  });

  it("timed-out NEVER deletes the shared bridge (user is still served by it)", async () => {
    const { client, deleteSharedBridgeAgent } = makeClient({
      status: "timed-out",
      imported: 0,
    });

    const outcome = await runSharedToDedicatedUpgradeHandoff({
      sharedAgentId: SHARED_ID,
      dedicatedAgentId: DEDICATED_ID,
      cloudApiBase: CLOUD_BASE,
      authToken: TOKEN,
      client,
    });

    expect(outcome).toEqual({
      status: "timed-out",
      imported: 0,
      sharedBridgeDeleted: false,
    });
    expect(deleteSharedBridgeAgent).not.toHaveBeenCalled();
  });

  it("failed propagates the handoff error and keeps the shared bridge", async () => {
    const { client, deleteSharedBridgeAgent } = makeClient({
      status: "failed",
      imported: 0,
      error: "shared messages read failed (HTTP 500)",
    });

    const outcome = await runSharedToDedicatedUpgradeHandoff({
      sharedAgentId: SHARED_ID,
      dedicatedAgentId: DEDICATED_ID,
      cloudApiBase: CLOUD_BASE,
      authToken: TOKEN,
      client,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBe("shared messages read failed (HTTP 500)");
    expect(outcome.sharedBridgeDeleted).toBe(false);
    expect(deleteSharedBridgeAgent).not.toHaveBeenCalled();
  });

  it("a failed shared delete surfaces (leaked row) without un-switching the outcome", async () => {
    const { client } = makeClient(
      { status: "switched", imported: 2 },
      { success: false, error: "shared bridge delete failed (HTTP 500)" },
    );

    const outcome = await runSharedToDedicatedUpgradeHandoff({
      sharedAgentId: SHARED_ID,
      dedicatedAgentId: DEDICATED_ID,
      cloudApiBase: CLOUD_BASE,
      authToken: TOKEN,
      client,
    });

    expect(outcome.status).toBe("switched");
    expect(outcome.imported).toBe(2);
    expect(outcome.sharedBridgeDeleted).toBe(false);
    expect(outcome.error).toBe("shared bridge delete failed (HTTP 500)");
  });
});
