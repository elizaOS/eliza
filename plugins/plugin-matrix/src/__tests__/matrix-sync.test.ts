/**
 * Deterministic PREPARED-wait tests using an in-memory event emitter rather
 * than a live homeserver.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { waitForMatrixPrepared } from "../matrix-sync.js";
import type { MatrixSyncTimeoutError } from "../types.js";

describe("waitForMatrixPrepared", () => {
  it("resolves when PREPARED arrives before the budget", async () => {
    const client = new EventEmitter();
    const pending = waitForMatrixPrepared(client, "sync", 500);
    queueMicrotask(() => client.emit("sync", "PREPARED"));
    await expect(pending).resolves.toBeUndefined();
    expect(client.listenerCount("sync")).toBe(0);
  });

  it("rejects a hung homeserver that never emits PREPARED", async () => {
    const client = new EventEmitter();
    const startedAt = Date.now();
    const failure = waitForMatrixPrepared(client, "sync", 80);
    await expect(failure).rejects.toMatchObject({
      name: "MatrixSyncTimeoutError",
      code: "MATRIX_INITIAL_SYNC_TIMEOUT",
      context: { timeoutMs: 80 },
      severity: "ephemeral",
    } satisfies Partial<MatrixSyncTimeoutError>);
    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(client.listenerCount("sync")).toBe(0);
  });
});
