/**
 * Verifies filesystem-backed runtime-operation pruning preserves a newer
 * operation's idempotency binding when an older operation reused the key.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FilesystemRuntimeOperationRepository } from "../../../src/runtime/operations/repository.js";
import type { RuntimeOperation } from "../../../src/runtime/operations/types.js";

const HOUR_MS = 60 * 60 * 1000;

let stateDir: string | undefined;

afterEach(async () => {
  if (stateDir) {
    await rm(stateDir, { recursive: true, force: true });
    stateDir = undefined;
  }
});

function operation(
  id: string,
  startedAt: number,
  idempotencyKey: string,
): RuntimeOperation {
  return {
    id,
    kind: "provider-switch",
    intent: { kind: "provider-switch", provider: "openai" },
    tier: "hot",
    idempotencyKey,
    status: "succeeded",
    phases: [],
    startedAt,
    finishedAt: startedAt,
  };
}

describe("FilesystemRuntimeOperationRepository idempotency pruning", () => {
  test("pruning an old operation preserves the current operation's reused key", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "runtime-ops-idempotency-"));
    const repository = new FilesystemRuntimeOperationRepository(stateDir, {
      retentionMs: 7 * 24 * HOUR_MS,
      maxRecords: 1,
    });
    const now = Date.now();
    const idempotencyKey = "cli-switch-openai";
    const oldOperation = operation(
      "old-operation",
      now - 30 * HOUR_MS,
      idempotencyKey,
    );
    const currentOperation = operation(
      "current-operation",
      now,
      idempotencyKey,
    );

    await repository.create(oldOperation);
    expect(await repository.findByIdempotencyKey(idempotencyKey)).toBeNull();

    await repository.create(currentOperation);
    expect(await repository.pruneTerminal(now)).toBe(1);

    expect(await repository.get(oldOperation.id)).toBeNull();
    expect(await repository.findByIdempotencyKey(idempotencyKey)).toEqual(
      currentOperation,
    );
  });
});
