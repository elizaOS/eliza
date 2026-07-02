/**
 * Approval-queue TOCTOU (issue #10721 / #10723 Bug 3).
 *
 * The old transition helpers were read-assert-write: the UPDATE carried no
 * `AND state = <expected>` guard, so an in-flight `approve()` racing
 * `purgeExpired()` could resurrect an expired request (expired -> approved, a
 * forbidden transition) and e.g. a spend_money would execute after expiry.
 *
 * These tests drive the real `PgApprovalQueue` against PGlite and force the
 * exact interleavings deterministically: a subclass hook runs the concurrent
 * writer between the read and the compare-and-swap write. The loser of every
 * race must get `ApprovalTransitionConflictError`, never a forbidden state.
 *
 * Run: bunx vitest run test/approval-queue.toctou.integration.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../packages/test/helpers/real-runtime.ts";
import { PgApprovalQueue } from "../src/lifeops/approval-queue.js";
import {
  type ApprovalEnqueueInput,
  type ApprovalRequest,
  ApprovalStateTransitionError,
  ApprovalTransitionConflictError,
} from "../src/lifeops/approval-queue.types.js";
import { personalAssistantPlugin } from "../src/plugin.js";

/**
 * PgApprovalQueue with a one-shot hook between the transition's read and its
 * compare-and-swap write — the deterministic stand-in for a concurrent writer
 * landing inside the race window.
 */
class InterleavedApprovalQueue extends PgApprovalQueue {
  public betweenReadAndWrite: (() => Promise<void>) | null = null;

  protected override async fetchById(
    id: string,
  ): Promise<ApprovalRequest | null> {
    const row = await super.fetchById(id);
    const hook = this.betweenReadAndWrite;
    this.betweenReadAndWrite = null;
    if (hook && row) await hook();
    return row;
  }
}

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let queue: InterleavedApprovalQueue;
let isolatedStateDir: string;

const isolatedEnvKeys = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;

const previousEnv = new Map<string, string | undefined>();

function setIsolatedEnv(): void {
  isolatedStateDir = mkdtempSync(join(tmpdir(), "approval-toctou-state-"));
  const isolatedConfigPath = join(isolatedStateDir, "eliza.json");
  writeFileSync(
    isolatedConfigPath,
    JSON.stringify({ logging: { level: "error" } }),
    "utf8",
  );
  for (const key of isolatedEnvKeys) {
    previousEnv.set(key, process.env[key]);
  }
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

function spendMoneyInput(
  overrides: Partial<ApprovalEnqueueInput> = {},
): ApprovalEnqueueInput {
  return {
    requestedBy: "agent:lifeops",
    subjectUserId: "owner-toctou",
    action: "spend_money",
    payload: {
      action: "spend_money",
      vendor: "Cloud GPUs Inc",
      amountCents: 250_00,
      currency: "USD",
      memo: "training run",
    },
    channel: "internal",
    reason: "agent wants to spend money",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

beforeAll(async () => {
  setIsolatedEnv();
  const result = await createRealTestRuntime({
    plugins: [personalAssistantPlugin],
  });
  runtime = result.runtime;
  cleanup = result.cleanup;
  queue = new InterleavedApprovalQueue(runtime, { agentId: runtime.agentId });
}, 180_000);

afterAll(async () => {
  await cleanup();
  restoreEnv();
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

describe("ApprovalQueue TOCTOU (real PGlite, controlled interleavings)", () => {
  it("an expiry landing inside approve()'s window cannot be overwritten", async () => {
    // Future expiresAt: the lazy expiry guard (#11092) must not preempt the
    // race — this test exercises the CAS window itself, with a concurrent
    // markExpired standing in for any pending -> expired transition.
    const enqueued = await queue.enqueue(
      spendMoneyInput({
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    );
    expect(enqueued.state).toBe("pending");

    // approve() reads `pending`, then the row expires before the approve
    // write lands — the classic race that used to resurrect the row.
    queue.betweenReadAndWrite = async () => {
      const expired = await queue.markExpired(enqueued.id);
      expect(expired.state).toBe("expired");
    };

    await expect(
      queue.approve(enqueued.id, {
        resolvedBy: "owner-toctou",
        resolutionReason: "approving too late",
      }),
    ).rejects.toBeInstanceOf(ApprovalTransitionConflictError);

    // The forbidden expired -> approved transition never happened.
    const after = await queue.byId(enqueued.id);
    expect(after?.state).toBe("expired");
    expect(after?.resolvedBy).toBeNull();
  }, 60_000);

  it("a lapsed pending request is refused and expired at the boundary — no purge needed (#11092)", async () => {
    // No interleaving hook: the guard itself must enforce expiry, because
    // nothing runs purgeExpired periodically in production.
    const enqueued = await queue.enqueue(
      spendMoneyInput({
        subjectUserId: "owner-lapsed",
        expiresAt: new Date(Date.now() - 5 * 60 * 1000),
      }),
    );
    expect(enqueued.state).toBe("pending");

    await expect(
      queue.approve(enqueued.id, {
        resolvedBy: "owner-lapsed",
        resolutionReason: "approving after expiry",
      }),
    ).rejects.toBeInstanceOf(ApprovalStateTransitionError);

    // The lazy guard flipped the row to expired; it never executed.
    const after = await queue.byId(enqueued.id);
    expect(after?.state).toBe("expired");
    expect(after?.resolvedBy).toBeNull();
  }, 60_000);

  it("double-approve race has exactly one winner; the loser gets a typed conflict", async () => {
    const enqueued = await queue.enqueue(
      spendMoneyInput({ subjectUserId: "owner-double-approve" }),
    );

    queue.betweenReadAndWrite = async () => {
      const inner = await queue.approve(enqueued.id, {
        resolvedBy: "owner-a",
        resolutionReason: "first approval wins",
      });
      expect(inner.state).toBe("approved");
    };

    await expect(
      queue.approve(enqueued.id, {
        resolvedBy: "owner-b",
        resolutionReason: "second approval must lose",
      }),
    ).rejects.toBeInstanceOf(ApprovalTransitionConflictError);

    const after = await queue.byId(enqueued.id);
    expect(after?.state).toBe("approved");
    expect(after?.resolvedBy).toBe("owner-a");
  }, 60_000);

  it("reject landing inside markExecuting()'s window blocks execution", async () => {
    const enqueued = await queue.enqueue(
      spendMoneyInput({ subjectUserId: "owner-reject-race" }),
    );
    await queue.approve(enqueued.id, {
      resolvedBy: "owner-reject-race",
      resolutionReason: "approved, then thought better of it",
    });

    queue.betweenReadAndWrite = async () => {
      const rejected = await queue.reject(enqueued.id, {
        resolvedBy: "owner-reject-race",
        resolutionReason: "changed my mind",
      });
      expect(rejected.state).toBe("rejected");
    };

    await expect(queue.markExecuting(enqueued.id)).rejects.toBeInstanceOf(
      ApprovalTransitionConflictError,
    );

    const after = await queue.byId(enqueued.id);
    expect(after?.state).toBe("rejected");
  }, 60_000);

  it("conflict is a distinct subclass of the transition error", async () => {
    const enqueued = await queue.enqueue(
      spendMoneyInput({ subjectUserId: "owner-error-shape" }),
    );
    queue.betweenReadAndWrite = async () => {
      await queue.reject(enqueued.id, {
        resolvedBy: "owner-error-shape",
        resolutionReason: "rejected mid-flight",
      });
    };
    const failure = await queue
      .approve(enqueued.id, {
        resolvedBy: "owner-error-shape",
        resolutionReason: "late approval",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ApprovalTransitionConflictError);
    expect(failure).toBeInstanceOf(ApprovalStateTransitionError);
    if (!(failure instanceof ApprovalTransitionConflictError)) {
      throw new Error("expected ApprovalTransitionConflictError");
    }
    expect(failure.requestId).toBe(enqueued.id);
    expect(failure.from).toBe("rejected");
    expect(failure.to).toBe("approved");
  }, 60_000);
});
