/**
 * LifeOps cross-device intent sync tests against a real PGLite runtime.
 *
 * Exercises broadcast / receive / acknowledge / prune over the local
 * `life_intents` table as well as the OWNER_DEVICE_INTENT action handler. No SQL
 * mocks, no LLM.
 */

import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/real-runtime";
import { ownerDeviceIntentAction } from "../src/actions/owner-device-intent.js";
import {
  acknowledgeIntent,
  broadcastIntent,
  pruneExpiredIntents,
  receivePendingIntents,
} from "../src/lifeops/intent-sync.js";
import { appLifeOpsPlugin } from "../src/plugin.js";

const AGENT_ID = "lifeops-intent-sync-agent";

function makeMessage(runtime: IAgentRuntime, text: string) {
  return {
    id: `msg-${Math.random()}` as unknown as string,
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    content: { text },
  };
}

describe("intent-sync — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: AGENT_ID,
      plugins: [appLifeOpsPlugin],
    });
    runtime = testResult.runtime;
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("broadcastIntent persists an intent", async () => {
    const intent = await broadcastIntent(runtime, {
      kind: "routine_reminder",
      title: "Take vitamins",
      body: "Don't forget your morning vitamins.",
      target: "mobile",
      priority: "medium",
    });
    expect(intent.id).toBeTruthy();
    expect(intent.target).toBe("mobile");
    expect(intent.kind).toBe("routine_reminder");
  });

  it("receivePendingIntents returns target-matching unacknowledged intents", async () => {
    await broadcastIntent(runtime, {
      kind: "user_action_requested",
      title: "A",
      body: "alpha",
      target: "mobile",
    });
    await broadcastIntent(runtime, {
      kind: "user_action_requested",
      title: "B",
      body: "beta",
      target: "desktop",
    });
    await broadcastIntent(runtime, {
      kind: "user_action_requested",
      title: "C",
      body: "gamma",
      target: "all",
    });
    const mobile = await receivePendingIntents(runtime, { device: "mobile" });
    // mobile-targeted + all-targeted intents must surface; desktop-only must not.
    const titles = mobile.map((i) => i.title);
    expect(titles).toContain("A");
    expect(titles).toContain("C");
    expect(titles).not.toContain("B");
  });

  it("acknowledgeIntent marks intent acknowledged and hides it from pending", async () => {
    const intent = await broadcastIntent(runtime, {
      kind: "attention_request",
      title: "ack-me",
      body: "please ack",
      target: "all",
    });
    await acknowledgeIntent(runtime, intent.id, "device-x");
    const pending = await receivePendingIntents(runtime, {});
    expect(pending.find((i) => i.id === intent.id)).toBeFalsy();
  });

  it("acknowledgeIntent suppresses later ladder rungs across devices", async () => {
    const ladderId = `meeting-${Date.now()}-${Math.random()}`;
    const firstRung = await broadcastIntent(runtime, {
      kind: "routine_reminder",
      title: "Board meeting in 1 hour",
      body: "First rung",
      target: "all",
      metadata: { ladderId, rungIndex: 0 },
    });
    await broadcastIntent(runtime, {
      kind: "routine_reminder",
      title: "Board meeting in 10 minutes",
      body: "Second rung",
      target: "all",
      metadata: { ladderId, rungIndex: 1 },
    });
    await broadcastIntent(runtime, {
      kind: "routine_reminder",
      title: "Board meeting starts now",
      body: "Third rung",
      target: "all",
      metadata: { ladderId, rungIndex: 2 },
    });

    const desktopPendingBefore = (
      await receivePendingIntents(runtime, {
        device: "desktop",
        deviceId: "mac-1",
      })
    ).filter((intent) => intent.metadata.ladderId === ladderId);
    const mobilePendingBefore = (
      await receivePendingIntents(runtime, {
        device: "mobile",
        deviceId: "ios-1",
      })
    ).filter((intent) => intent.metadata.ladderId === ladderId);

    expect(desktopPendingBefore).toHaveLength(3);
    expect(mobilePendingBefore).toHaveLength(3);

    await acknowledgeIntent(runtime, firstRung.id, "mac-1");

    const desktopPendingAfter = (
      await receivePendingIntents(runtime, {
        device: "desktop",
        deviceId: "mac-1",
      })
    ).filter((intent) => intent.metadata.ladderId === ladderId);
    const mobilePendingAfter = (
      await receivePendingIntents(runtime, {
        device: "mobile",
        deviceId: "ios-1",
      })
    ).filter((intent) => intent.metadata.ladderId === ladderId);

    expect(desktopPendingAfter).toHaveLength(0);
    expect(mobilePendingAfter).toHaveLength(0);
  });

  it("pruneExpiredIntents removes expired intents", async () => {
    await broadcastIntent(runtime, {
      kind: "state_sync",
      title: "expire",
      body: "should expire",
      target: "all",
      expiresInMinutes: 0.001,
    });
    // Wait long enough for expiresAt to be strictly in the past.
    await new Promise((r) => setTimeout(r, 200));
    const result = await pruneExpiredIntents(runtime);
    expect(result.pruned).toBeGreaterThanOrEqual(1);
  });

  it("ownerDeviceIntentAction broadcast subaction creates an intent", async () => {
    const result = await ownerDeviceIntentAction.handler!(
      runtime,
      makeMessage(runtime, "broadcast a reminder") as never,
      undefined,
      {
        parameters: {
          subaction: "broadcast",
          kind: "routine_reminder",
          title: "via-action",
          body: "broadcast through the action handler",
          target: "all",
          priority: "low",
        },
      } as never,
      async () => {},
    );
    expect(result?.success).toBe(true);
    const data = (
      result as unknown as { data?: { intent?: { id: string; title: string } } }
    ).data;
    expect(data?.intent?.title).toBe("via-action");
    const pending = await receivePendingIntents(runtime, {});
    expect(pending.find((i) => i.id === data?.intent?.id)).toBeTruthy();
  });

  it("ownerDeviceIntentAction list_pending subaction returns count", async () => {
    const result = await ownerDeviceIntentAction.handler!(
      runtime,
      makeMessage(runtime, "list pending intents") as never,
      undefined,
      { parameters: { subaction: "list_pending" } } as never,
      async () => {},
    );
    expect(result?.success).toBe(true);
    const values = (result as unknown as { values?: { count?: number } })
      .values;
    expect(typeof values?.count).toBe("number");
  });

  it("ownerDeviceIntentAction acknowledge suppresses the remaining ladder rungs", async () => {
    const ladderId = `ack-action-${Date.now()}-${Math.random()}`;
    const firstRung = await broadcastIntent(runtime, {
      kind: "routine_reminder",
      title: "Standup in 1 hour",
      body: "First rung",
      target: "all",
      metadata: { ladderId, rungIndex: 0 },
    });
    await broadcastIntent(runtime, {
      kind: "routine_reminder",
      title: "Standup in 10 minutes",
      body: "Second rung",
      target: "all",
      metadata: { ladderId, rungIndex: 1 },
    });

    const result = await ownerDeviceIntentAction.handler!(
      runtime,
      makeMessage(runtime, "acknowledge ladder reminder") as never,
      undefined,
      {
        parameters: {
          subaction: "acknowledge",
          intentId: firstRung.id,
          deviceId: "desktop-main",
        },
      } as never,
      async () => {},
    );

    expect(result?.success).toBe(true);
    const pending = await receivePendingIntents(runtime, {
      device: "mobile",
      deviceId: "ios-main",
    });
    const ladderPending = pending.filter(
      (intent) => intent.metadata.ladderId === ladderId,
    );
    expect(ladderPending).toHaveLength(0);
  });

  it("ownerDeviceIntentAction broadcast rejects unknown kind", async () => {
    const result = await ownerDeviceIntentAction.handler!(
      runtime,
      makeMessage(runtime, "bad broadcast") as never,
      undefined,
      {
        parameters: {
          subaction: "broadcast",
          kind: "not_a_real_kind",
          title: "x",
          body: "y",
        },
      } as never,
      async () => {},
    );
    // validationTerminate returns success:false at both the top level and
    // values.success (the action did NOT complete the broadcast because the
    // kind was invalid); a descriptive error code is set for downstream
    // consumers.
    expect((result as unknown as { success?: boolean }).success).toBe(false);
    expect(
      (result as unknown as { values?: { success?: boolean } }).values?.success,
    ).toBe(false);
    expect(
      (result as unknown as { data?: { error?: string } }).data?.error,
    ).toBe("UNKNOWN_KIND");
  });

  it("ownerDeviceIntentAction treats a leaked intent kind in subaction as a broadcast", async () => {
    const result = await ownerDeviceIntentAction.handler!(
      runtime,
      makeMessage(runtime, "broadcast a stretch reminder") as never,
      undefined,
      {
        parameters: {
          subaction: "routine_reminder",
          title: "Stretch break",
          body: "Get up and stretch",
          target: "mobile",
        },
      } as never,
      async () => {},
    );

    expect(result?.success).toBe(true);
    const data = (
      result as unknown as {
        data?: { intent?: { kind: string; title: string; target: string } };
      }
    ).data;
    expect(data?.intent?.kind).toBe("routine_reminder");
    expect(data?.intent?.title).toBe("Stretch break");
    expect(data?.intent?.target).toBe("mobile");
  });

  it("ownerDeviceIntentAction defaults structured payloads without subaction to broadcast", async () => {
    const result = await ownerDeviceIntentAction.handler!(
      runtime,
      makeMessage(runtime, "broadcast a phone reminder") as never,
      undefined,
      {
        parameters: {
          kind: "routine_reminder",
          title: "Phone reminder",
          body: "Take a quick walk",
          target: "mobile",
        },
      } as never,
      async () => {},
    );

    expect(result?.success).toBe(true);
    const data = (
      result as unknown as {
        data?: { intent?: { kind: string; title: string; target: string } };
      }
    ).data;
    expect(data?.intent?.kind).toBe("routine_reminder");
    expect(data?.intent?.title).toBe("Phone reminder");
    expect(data?.intent?.target).toBe("mobile");
  });

  it("escalateUnacknowledgedIntents escalates desktop intents to mobile when ignored", async () => {
    // 1. Broadcast an intent to desktop
    const intent = await broadcastIntent(runtime, {
      kind: "attention_request",
      title: "Confirm travel",
      body: "Need to confirm travel arrangements",
      target: "desktop",
      priority: "medium",
    });

    // 2. We mock its creation time to be 10 minutes ago to simulate it being ignored
    const cutoffTime = new Date(Date.now() - 10 * 60_000).toISOString();
    await runtime.databaseAdapter.db.execute(
      `UPDATE life_intents SET created_at = $1 WHERE id = $2`,
      [cutoffTime, intent.id],
    );

    // 3. Trigger escalation
    const { escalateUnacknowledgedIntents } = await import(
      "../src/lifeops/intent-sync.js"
    );
    const result = await escalateUnacknowledgedIntents(runtime, {
      thresholdMinutes: 5,
    });

    expect(result.escalated).toBeGreaterThanOrEqual(1);

    // 4. Verify that the desktop intent is now acknowledged
    const pendingDesktop = await receivePendingIntents(runtime, {
      device: "desktop",
    });
    expect(pendingDesktop.find((i) => i.id === intent.id)).toBeFalsy();

    // 5. Verify that a mobile intent was created
    const pendingMobile = await receivePendingIntents(runtime, {
      device: "mobile",
    });
    const escalatedIntent = pendingMobile.find(
      (i) => i.metadata?.escalatedFrom === intent.id,
    );
    expect(escalatedIntent).toBeTruthy();
    expect(escalatedIntent?.title).toContain("[Escalated]");
    expect(escalatedIntent?.priority).toBe("high");
  });
});
