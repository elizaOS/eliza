/**
 * Deterministic concurrency and crash tests for the reference durable command
 * journal; cryptographic admission is represented by its verified digest.
 */

import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  REMOTE_CONTROL_SIGNATURE_ALGORITHM,
  type RemoteCommandBody,
  type RemoteControllerGrant,
  type SignedRemoteCommand,
} from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { digestRemoteCommand } from "./remote-control-crypto.js";
import {
  executeReservedRemoteCommand,
  InMemoryDurableRemoteCommandJournal,
} from "./remote-control-journal.js";

const NOW = 2_000_000_000_000;

const grant: RemoteControllerGrant = {
  version: REMOTE_CONTROL_PROTOCOL_VERSION,
  grantId: "grant-1",
  revision: 1,
  ownerId: "owner-1",
  controllerDeviceId: "controller-1",
  controllerKeyId: "controller-key-1",
  targetRuntimeIds: ["runtime-1"],
  sessionId: "session-1",
  createdAt: NOW - 10_000,
  expiresAt: null,
  revokedAt: null,
};

function command(
  overrides: Partial<RemoteCommandBody> = {},
): SignedRemoteCommand {
  return {
    body: {
      version: REMOTE_CONTROL_PROTOCOL_VERSION,
      ownerId: "owner-1",
      grantId: "grant-1",
      grantRevision: 1,
      sessionId: "session-1",
      controllerDeviceId: "controller-1",
      controllerKeyId: "controller-key-1",
      targetRuntimeId: "runtime-1",
      targetKeyId: "target-key-1",
      commandId: "command-1",
      sequence: 1,
      nonce: "nonce-1",
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 20_000,
      action: "agent.message",
      payload: { message: "hello" },
      payloadDigest: "payload-digest",
      ...overrides,
    },
    signatureAlgorithm: REMOTE_CONTROL_SIGNATURE_ALGORITHM,
    signature: "signature",
  };
}

describe("durable remote command journal", () => {
  let journal: InMemoryDurableRemoteCommandJournal;

  beforeEach(async () => {
    journal = new InMemoryDurableRemoteCommandJournal();
    await journal.installAuthority(grant);
  });

  it("atomically reserves a nonce/sequence and idempotently returns the record", async () => {
    const input = {
      command: command(),
      commandDigest: digestRemoteCommand(command()),
      now: NOW,
    };
    await expect(journal.authorizeAndReserve(input)).resolves.toMatchObject({
      ok: true,
      disposition: "reserved",
    });
    await expect(journal.authorizeAndReserve(input)).resolves.toMatchObject({
      ok: true,
      disposition: "duplicate",
      record: { status: "reserved" },
    });
    await expect(
      journal.authorizeAndReserve({
        ...input,
        command: command({ payload: { message: "changed" } }),
        commandDigest: digestRemoteCommand(
          command({ payload: { message: "changed" } }),
        ),
      }),
    ).resolves.toEqual({ ok: false, reason: "command_conflict" });
  });

  it("allows only one of two concurrent commands with the same sequence", async () => {
    const results = await Promise.all([
      journal.authorizeAndReserve({
        command: command(),
        commandDigest: digestRemoteCommand(command()),
        now: NOW,
      }),
      journal.authorizeAndReserve({
        command: command({ commandId: "command-2", nonce: "nonce-2" }),
        commandDigest: digestRemoteCommand(
          command({ commandId: "command-2", nonce: "nonce-2" }),
        ),
        now: NOW,
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "replay" },
    ]);
  });

  it("serializes revocation before replay consumption", async () => {
    await journal.installAuthority({
      ...grant,
      revision: 2,
      revokedAt: NOW - 1,
    });
    await expect(
      journal.authorizeAndReserve({
        command: command({ grantRevision: 2 }),
        commandDigest: digestRemoteCommand(command({ grantRevision: 2 })),
        now: NOW,
      }),
    ).resolves.toEqual({ ok: false, reason: "revoked" });

    const freshGrant = {
      ...grant,
      grantId: "grant-2",
      sessionId: "session-2",
    };
    await journal.installAuthority(freshGrant);
    await expect(
      journal.authorizeAndReserve({
        command: command({ grantId: "grant-2", sessionId: "session-2" }),
        commandDigest: digestRemoteCommand(
          command({ grantId: "grant-2", sessionId: "session-2" }),
        ),
        now: NOW,
      }),
    ).resolves.toMatchObject({ ok: true, disposition: "reserved" });
  });

  it("retries a crash-before-start reservation and invokes the effect once", async () => {
    const signed = command();
    await journal.authorizeAndReserve({
      command: signed,
      commandDigest: digestRemoteCommand(signed),
      now: NOW,
    });
    await expect(
      journal.authorizeAndReserve({
        command: signed,
        commandDigest: digestRemoteCommand(signed),
        now: NOW + 1,
      }),
    ).resolves.toMatchObject({
      ok: true,
      disposition: "duplicate",
      record: { status: "reserved" },
    });
    const effect = vi.fn(async () => ({
      status: "completed" as const,
      result: { ok: true },
      resultDigest: "result-digest",
    }));
    await expect(
      executeReservedRemoteCommand(journal, {
        commandId: signed.body.commandId,
        startedAt: NOW + 2,
        completedAt: () => NOW + 3,
        effect,
      }),
    ).resolves.toMatchObject({
      disposition: "completed",
      record: { status: "completed" },
    });
    expect(effect).toHaveBeenCalledTimes(1);
    await executeReservedRemoteCommand(journal, {
      commandId: signed.body.commandId,
      startedAt: NOW + 4,
      completedAt: () => NOW + 5,
      effect,
    });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("never retries a crash-after-start and exposes execution ambiguity", async () => {
    const signed = command();
    await journal.authorizeAndReserve({
      command: signed,
      commandDigest: digestRemoteCommand(signed),
      now: NOW,
    });
    await journal.beginExecution(signed.body.commandId, NOW + 1);
    await expect(
      journal.recoverInterruptedExecutions(NOW + 2),
    ).resolves.toMatchObject([
      { commandId: "command-1", status: "execution_ambiguous" },
    ]);
    const effect = vi.fn();
    await expect(
      executeReservedRemoteCommand(journal, {
        commandId: signed.body.commandId,
        startedAt: NOW + 3,
        completedAt: () => NOW + 4,
        effect,
      }),
    ).resolves.toMatchObject({
      disposition: "terminal",
      record: { status: "execution_ambiguous" },
    });
    expect(effect).not.toHaveBeenCalled();
  });

  it("makes duplicate completion idempotent and rejects conflicting results", async () => {
    await journal.authorizeAndReserve({
      command: command(),
      commandDigest: digestRemoteCommand(command()),
      now: NOW,
    });
    const start = await journal.beginExecution("command-1", NOW + 1);
    expect(start.ok).toBe(true);
    if (!start.ok || !start.record.executionId)
      throw new Error("missing execution");
    const completion = {
      commandId: "command-1",
      executionId: start.record.executionId,
      status: "completed" as const,
      completedAt: NOW + 2,
      resultDigest: "result-digest",
    };
    await expect(journal.completeExecution(completion)).resolves.toMatchObject({
      ok: true,
      disposition: "completed",
    });
    await expect(journal.completeExecution(completion)).resolves.toMatchObject({
      ok: true,
      disposition: "duplicate",
    });
    await expect(
      journal.completeExecution({ ...completion, resultDigest: "different" }),
    ).resolves.toEqual({ ok: false, reason: "result_conflict" });
  });

  it("bounds replay state to the session lifecycle", async () => {
    await journal.authorizeAndReserve({
      command: command(),
      commandDigest: digestRemoteCommand(command()),
      now: NOW,
    });
    await expect(
      journal.terminateSession("session-1", NOW + 1),
    ).resolves.toEqual({
      sessionId: "session-1",
      terminatedAt: NOW + 1,
      reservedRejected: 1,
      startedAmbiguous: 0,
      replayEntriesDeleted: 1,
      authoritiesRevoked: 1,
    });
    await expect(journal.get("command-1")).resolves.toMatchObject({
      status: "rejected",
      errorCode: "REMOTE_SESSION_TERMINATED",
    });
  });
});
