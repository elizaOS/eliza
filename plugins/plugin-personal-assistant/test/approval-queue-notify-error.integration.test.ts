/**
 * Approval-queue notify-failure path (real PGlite runtime, #12273).
 *
 * Enqueue surfaces a pending approval on the notification rail as a
 * fire-and-forget side-channel. This drives a NOTIFICATION service whose
 * `notify` rejects and asserts the failure is now reported via
 * `runtime.reportError` (scope `ApprovalQueue.notify`) instead of being
 * swallowed by a bare `.catch(() => {})`, while the enqueue itself still
 * succeeds (the persisted approval row is unaffected).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRuntime,
  type IAgentRuntime,
  Service,
  ServiceType,
} from "@elizaos/core";
import { schedulingPlugin } from "@elizaos/plugin-scheduling";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../packages/test/helpers/real-runtime.ts";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import type {
  ApprovalEnqueueInput,
  ApprovalQueue,
} from "../src/lifeops/approval-queue.types.js";
import { personalAssistantPlugin } from "../src/plugin.js";

class FailingNotificationService extends Service {
  static override serviceType = ServiceType.NOTIFICATION;
  static override allowsMultiple = true;
  override capabilityDescription = "Test notifier that always rejects";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<FailingNotificationService> {
    return new FailingNotificationService(runtime);
  }

  async notify(): Promise<never> {
    throw new Error("notification rail unavailable");
  }

  override async stop(): Promise<void> {}
}

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let queue: ApprovalQueue;
let stateDir: string;

function messageInput(): ApprovalEnqueueInput {
  return {
    requestedBy: "agent:lifeops",
    subjectUserId: "owner-notify",
    action: "send_message",
    payload: {
      action: "send_message",
      recipient: "+15555551212",
      body: "Hello!",
      replyToMessageId: null,
    },
    channel: "sms",
    reason: "agent wants to confirm before sending",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
}

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "approval-notify-err-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  const result = await createRealTestRuntime({
    plugins: [schedulingPlugin, personalAssistantPlugin],
  });
  runtime = result.runtime;
  cleanup = result.cleanup;
  await runtime.registerService(FailingNotificationService);
  await runtime.getServiceLoadPromise(ServiceType.NOTIFICATION);
  queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
}, 180_000);

afterAll(async () => {
  await cleanup();
  delete process.env.ELIZA_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("ApprovalQueue notify failure (real PGlite)", () => {
  it("reports a failed notification via reportError but still persists the approval", async () => {
    // Sanity: the failing notifier is the one the queue will resolve.
    const notifier = runtime.getService(ServiceType.NOTIFICATION);
    expect(notifier).toBeInstanceOf(FailingNotificationService);

    const before = runtime
      .getRecentReportedErrors()
      .filter((e) => e.scope === "ApprovalQueue.notify").length;

    const enqueued = await queue.enqueue(messageInput());

    // The enqueue itself must succeed: a broken notification rail cannot lose
    // the approval row the owner still has to act on.
    expect(enqueued.state).toBe("pending");
    const fetched = await queue.byId(enqueued.id);
    expect(fetched?.id).toBe(enqueued.id);

    // notify is fire-and-forget; poll the reported-error ring until the
    // rejection has propagated through `.catch → reportError`.
    let reported = false;
    for (let i = 0; i < 50 && !reported; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      const entry = runtime
        .getRecentReportedErrors()
        .filter((e) => e.scope === "ApprovalQueue.notify");
      reported = entry.length > before;
    }
    expect(reported).toBe(true);

    const latest = runtime
      .getRecentReportedErrors()
      .filter((e) => e.scope === "ApprovalQueue.notify")
      .at(-1);
    expect(latest?.context?.requestId).toBe(enqueued.id);
    expect(latest?.context?.action).toBe("send_message");
  }, 60_000);
});
