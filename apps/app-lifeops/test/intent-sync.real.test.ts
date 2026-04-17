/**
 * LifeOps cross-device intent sync tests against a real PGLite runtime.
 *
 * Exercises broadcast / receive / acknowledge / prune over the local
 * `life_intents` table as well as the INTENT_SYNC action handler. No SQL
 * mocks, no LLM.
 */

import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../../test/helpers/real-runtime";
import {
  acknowledgeIntent,
  broadcastIntent,
  pruneExpiredIntents,
  receivePendingIntents,
} from "../src/lifeops/intent-sync.js";
import { intentSyncAction } from "../src/actions/intent-sync.js";

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
    testResult = await createRealTestRuntime({ characterName: AGENT_ID });
    runtime = testResult.runtime;
    // intent-sync ensures its own table on first call; no schema bootstrap
    // needed for life_intents specifically.
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

  it("intentSyncAction broadcast subaction creates an intent", async () => {
    const result = await intentSyncAction.handler!(
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

  it("intentSyncAction list_pending subaction returns count", async () => {
    const result = await intentSyncAction.handler!(
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

  it("intentSyncAction broadcast rejects unknown kind", async () => {
    const result = await intentSyncAction.handler!(
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
    expect(result?.success).toBe(false);
    expect(
      (result as unknown as { data?: { error?: string } }).data?.error,
    ).toBe("UNKNOWN_KIND");
  });
});
