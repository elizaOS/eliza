/**
 * Approval queue integration test (WS6).
 *
 * Drives the real `PgApprovalQueue` against a PGlite-backed runtime.
 * Exercises:
 *   - enqueue → approve → markExecuting → markDone (happy path)
 *   - enqueue → reject
 *   - enqueue (expired in past) → purgeExpired → markExpired noop rejected
 *   - invalid transitions throw ApprovalStateTransitionError
 *
 * Run: bunx vitest run eliza/plugins/app-lifeops/test/approval-queue.integration.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../test/helpers/real-runtime";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import {
  type ApprovalEnqueueInput,
  ApprovalNotFoundError,
  type ApprovalQueue,
  ApprovalStateTransitionError,
} from "../src/lifeops/approval-queue.types.js";
import { appLifeOpsPlugin } from "../src/plugin.js";

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let queue: ApprovalQueue;
let isolatedStateDir: string;
let isolatedConfigPath: string;

const isolatedEnvKeys = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;

const previousEnv = new Map<string, string | undefined>();

function setIsolatedEnv(): void {
  isolatedStateDir = mkdtempSync(join(tmpdir(), "approval-queue-state-"));
  isolatedConfigPath = join(isolatedStateDir, "eliza.json");
  writeFileSync(
    isolatedConfigPath,
    JSON.stringify({ logging: { level: "error" } }),
    "utf8",
  );
  for (const key of isolatedEnvKeys) {
    previousEnv.set(key, process.env[key]);
  }
  process.env.ELIZA_STATE_DIR = isolatedStateDir;
  process.env.ELIZA_CONFIG_PATH = isolatedConfigPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = isolatedConfigPath;
  delete process.env.ELIZA_STATE_DIR;
  delete process.env.ELIZA_CONFIG_PATH;
  delete process.env.ELIZA_PERSIST_CONFIG_PATH;
  delete process.env.ELIZAOS_CLOUD_API_KEY;
  delete process.env.ELIZAOS_CLOUD_BASE_URL;
}

function restoreEnv(): void {
  for (const key of isolatedEnvKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

function messageInput(
  overrides: Partial<ApprovalEnqueueInput> = {},
): ApprovalEnqueueInput {
  return {
    requestedBy: "agent:lifeops",
    subjectUserId: "owner-123",
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
    ...overrides,
  };
}

beforeAll(async () => {
  setIsolatedEnv();
  const result = await createRealTestRuntime({
    plugins: [appLifeOpsPlugin],
  });
  runtime = result.runtime;
  cleanup = result.cleanup;
  queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
}, 180_000);

afterAll(async () => {
  await cleanup();
  restoreEnv();
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

describe("ApprovalQueue integration (real PGlite)", () => {
  it("enqueue → approve → markExecuting → markDone happy path", async () => {
    const enqueued = await queue.enqueue(messageInput());
    expect(enqueued.state).toBe("pending");
    expect(enqueued.resolvedAt).toBeNull();
    expect(enqueued.resolvedBy).toBeNull();

    const fetched = await queue.byId(enqueued.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.action).toBe("send_message");

    const approved = await queue.approve(enqueued.id, {
      resolvedBy: "owner-123",
      resolutionReason: "looks good",
    });
    expect(approved.state).toBe("approved");
    expect(approved.resolvedBy).toBe("owner-123");
    expect(approved.resolvedAt).toBeInstanceOf(Date);

    const executing = await queue.markExecuting(enqueued.id);
    expect(executing.state).toBe("executing");

    const done = await queue.markDone(enqueued.id);
    expect(done.state).toBe("done");

    const pendingList = await queue.list({
      subjectUserId: "owner-123",
      state: "pending",
      action: null,
      limit: 10,
    });
    expect(pendingList.every((r) => r.id !== enqueued.id)).toBe(true);
  }, 60_000);

  it("enqueue → reject records resolver", async () => {
    const enqueued = await queue.enqueue(
      messageInput({ subjectUserId: "owner-reject" }),
    );
    const rejected = await queue.reject(enqueued.id, {
      resolvedBy: "owner-reject",
      resolutionReason: "not now",
    });
    expect(rejected.state).toBe("rejected");
    expect(rejected.resolutionReason).toBe("not now");
  }, 60_000);

  it("purgeExpired moves past-due pending rows to expired", async () => {
    const pastExpiry = new Date(Date.now() - 5 * 60 * 1000);
    const enqueued = await queue.enqueue(
      messageInput({
        subjectUserId: "owner-expire",
        expiresAt: pastExpiry,
      }),
    );
    const purgedIds = await queue.purgeExpired(new Date());
    expect(purgedIds).toContain(enqueued.id);
    const after = await queue.byId(enqueued.id);
    expect(after?.state).toBe("expired");
  }, 60_000);

  it("rejects invalid state transitions hard", async () => {
    const enqueued = await queue.enqueue(
      messageInput({ subjectUserId: "owner-invalid" }),
    );
    // pending -> executing is not allowed; must go through approved first
    await expect(queue.markExecuting(enqueued.id)).rejects.toBeInstanceOf(
      ApprovalStateTransitionError,
    );
    // pending -> done is not allowed
    await expect(queue.markDone(enqueued.id)).rejects.toBeInstanceOf(
      ApprovalStateTransitionError,
    );
  }, 60_000);

  it("throws ApprovalNotFoundError on unknown id", async () => {
    await expect(
      queue.approve("00000000-0000-0000-0000-000000000000", {
        resolvedBy: "owner-123",
        resolutionReason: "x",
      }),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  }, 60_000);
});
