/**
 * Isolated PREPARED-wait tests for Matrix connect. Uses a fake emitter; no
 * live homeserver and no MatrixService boot.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { waitForMatrixPrepared } from "../matrix-sync.js";
import { MatrixSyncTimeoutError } from "../types.js";

describe("waitForMatrixPrepared", () => {
  it("resolves when PREPARED arrives before the budget", async () => {
    const client = new EventEmitter();
    const pending = waitForMatrixPrepared(client, "sync", 500);
    queueMicrotask(() => client.emit("sync", "PREPARED"));
    await expect(pending).resolves.toBeUndefined();
  });

  it("rejects a hung homeserver that never emits PREPARED", async () => {
    const client = new EventEmitter();
    const startedAt = Date.now();
    await expect(waitForMatrixPrepared(client, "sync", 80)).rejects.toBeInstanceOf(
      MatrixSyncTimeoutError
    );
    expect(Date.now() - startedAt).toBeLessThan(400);
  });
});
