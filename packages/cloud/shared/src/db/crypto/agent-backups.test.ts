/**
 * Unit tests for agent-backup `state_data` field encryption and its envelope type guard.
 *
 * The harness is deterministic and drives the real module: MemoryKmsAdapter is
 * selected by `createKmsClient()` when NODE_ENV=test. Durability-across-restart
 * cases live in the sibling roundtrip suite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentBackupDeltaData,
  AgentBackupStateData,
  AgentBackupStoredStateData,
  EncryptedAgentBackupStateData,
} from "../schemas/agent-sandboxes";
import {
  decryptAgentBackupStateData,
  encryptAgentBackupStateData,
  isEncryptedAgentBackupStateData,
} from "./agent-backups";
import { resetKmsClientForTests } from "./kms-client";

const ORG = "org-agent-backups-unit";
const BACKUP_ID = "backup-unit-0001";
const BACKUP_ID_B = "backup-unit-0002";

function sampleState(): AgentBackupStateData {
  return {
    memories: [{ role: "user", text: "hello — 世界", timestamp: 1 }],
    config: { name: "Unit Agent", nested: { n: 1 } },
    workspaceFiles: { "notes.md": "# notes" },
  };
}

function sampleDelta(): AgentBackupDeltaData {
  return {
    filesChanged: { "notes.md": "# changed" },
    filesRemoved: ["old.txt"],
    configChanged: { name: "Renamed" },
    configRemoved: ["plugins"],
    memoriesBaseCount: 3,
    memoriesAppended: [{ role: "assistant", text: "ok", timestamp: 2 }],
  };
}

function envelope(): EncryptedAgentBackupStateData {
  return {
    kind: "encrypted-agent-backup-state",
    algorithm: "kms-aes-256-gcm",
    ciphertext: "Y2lwaGVy",
    nonce: "bm9uY2U=",
    auth_tag: "dGFn",
    kms_key_id: "org/test/dek",
    kms_key_version: 1,
  };
}

function asStored(value: unknown): AgentBackupStoredStateData {
  return value as AgentBackupStoredStateData;
}

beforeEach(() => {
  resetKmsClientForTests();
});

afterEach(() => {
  resetKmsClientForTests();
});

describe("isEncryptedAgentBackupStateData", () => {
  test("rejects non-objects", () => {
    expect(isEncryptedAgentBackupStateData(undefined)).toBe(false);
    expect(isEncryptedAgentBackupStateData(null)).toBe(false);
    expect(isEncryptedAgentBackupStateData("encrypted-agent-backup-state")).toBe(false);
    expect(isEncryptedAgentBackupStateData(1)).toBe(false);
    expect(isEncryptedAgentBackupStateData(true)).toBe(false);
  });

  test("rejects arrays and empty objects", () => {
    expect(isEncryptedAgentBackupStateData([])).toBe(false);
    expect(isEncryptedAgentBackupStateData({})).toBe(false);
  });

  test("rejects a missing or wrong kind", () => {
    expect(isEncryptedAgentBackupStateData({ ...envelope(), kind: "other" })).toBe(false);
    const { kind: _kind, ...rest } = envelope();
    expect(isEncryptedAgentBackupStateData(rest)).toBe(false);
  });

  test("rejects a missing or wrong algorithm", () => {
    expect(isEncryptedAgentBackupStateData({ ...envelope(), algorithm: "aes-256-gcm" })).toBe(
      false,
    );
    const { algorithm: _algorithm, ...rest } = envelope();
    expect(isEncryptedAgentBackupStateData(rest)).toBe(false);
  });

  test("rejects non-string ciphertext, nonce, auth_tag, or kms_key_id", () => {
    expect(isEncryptedAgentBackupStateData({ ...envelope(), ciphertext: 1 })).toBe(false);
    expect(isEncryptedAgentBackupStateData({ ...envelope(), nonce: null })).toBe(false);
    expect(isEncryptedAgentBackupStateData({ ...envelope(), auth_tag: undefined })).toBe(false);
    expect(isEncryptedAgentBackupStateData({ ...envelope(), kms_key_id: { id: "x" } })).toBe(false);
    const { ciphertext: _c, ...noCipher } = envelope();
    expect(isEncryptedAgentBackupStateData(noCipher)).toBe(false);
  });

  test("rejects a missing or non-number kms_key_version", () => {
    expect(isEncryptedAgentBackupStateData({ ...envelope(), kms_key_version: "1" })).toBe(false);
    const { kms_key_version: _v, ...rest } = envelope();
    expect(isEncryptedAgentBackupStateData(rest)).toBe(false);
  });

  test("accepts a complete envelope, including extra fields and numeric edge versions", () => {
    expect(isEncryptedAgentBackupStateData(envelope())).toBe(true);
    expect(isEncryptedAgentBackupStateData({ ...envelope(), extra: true })).toBe(true);
    expect(isEncryptedAgentBackupStateData({ ...envelope(), kms_key_version: 0 })).toBe(true);
    expect(isEncryptedAgentBackupStateData({ ...envelope(), kms_key_version: Number.NaN })).toBe(
      true,
    );
    expect(
      isEncryptedAgentBackupStateData({
        ...envelope(),
        ciphertext: "",
        nonce: "",
        auth_tag: "",
        kms_key_id: "",
      }),
    ).toBe(true);
  });
});

describe("encryptAgentBackupStateData", () => {
  test("returns the same object when the input is already an envelope", async () => {
    const stored = envelope();
    const again = await encryptAgentBackupStateData(ORG, BACKUP_ID, stored);
    expect(again).toBe(stored);
  });

  test("seals plaintext full-state and delta payloads", async () => {
    const state = sampleState();
    const sealed = await encryptAgentBackupStateData(ORG, BACKUP_ID, state);
    expect(isEncryptedAgentBackupStateData(sealed)).toBe(true);
    expect(sealed.kind).toBe("encrypted-agent-backup-state");
    expect(sealed.algorithm).toBe("kms-aes-256-gcm");
    expect(typeof sealed.ciphertext).toBe("string");
    expect(typeof sealed.nonce).toBe("string");
    expect(typeof sealed.auth_tag).toBe("string");
    expect(typeof sealed.kms_key_id).toBe("string");
    expect(typeof sealed.kms_key_version).toBe("number");
    expect(JSON.stringify(sealed)).not.toContain("hello — 世界");
    expect(state.memories[0]?.text).toBe("hello — 世界");

    const delta = sampleDelta();
    const sealedDelta = await encryptAgentBackupStateData(ORG, BACKUP_ID, delta);
    expect(isEncryptedAgentBackupStateData(sealedDelta)).toBe(true);
    expect(JSON.stringify(sealedDelta)).not.toContain("# changed");
  });

  test("seals a near-envelope that fails the type guard instead of passing it through", async () => {
    const almost = asStored({ ...envelope(), kind: "not-an-envelope" });
    const sealed = await encryptAgentBackupStateData(ORG, BACKUP_ID, almost);
    expect(sealed).not.toBe(almost);
    expect(isEncryptedAgentBackupStateData(sealed)).toBe(true);
    expect(sealed.kind).toBe("encrypted-agent-backup-state");
  });

  test("seals empty collections", async () => {
    const empty: AgentBackupStateData = {
      memories: [],
      config: {},
      workspaceFiles: {},
    };
    const sealed = await encryptAgentBackupStateData(ORG, BACKUP_ID, empty);
    expect(isEncryptedAgentBackupStateData(sealed)).toBe(true);
    const restored = await decryptAgentBackupStateData(BACKUP_ID, sealed);
    expect(restored).toEqual(empty);
  });
});

describe("decryptAgentBackupStateData", () => {
  test("returns the same object when the input is not an envelope", async () => {
    const state = sampleState();
    expect(await decryptAgentBackupStateData(BACKUP_ID, state)).toBe(state);

    const delta = sampleDelta();
    expect(await decryptAgentBackupStateData(BACKUP_ID, delta)).toBe(delta);

    const almost = asStored({ ...envelope(), algorithm: "plain" });
    expect(await decryptAgentBackupStateData(BACKUP_ID, almost)).toBe(almost);
  });

  test("round-trips full-state and delta payloads", async () => {
    const state = sampleState();
    const sealed = await encryptAgentBackupStateData(ORG, BACKUP_ID, state);
    expect(await decryptAgentBackupStateData(BACKUP_ID, sealed)).toEqual(state);

    const delta = sampleDelta();
    const sealedDelta = await encryptAgentBackupStateData(ORG, BACKUP_ID, delta);
    expect(await decryptAgentBackupStateData(BACKUP_ID, sealedDelta)).toEqual(delta);
  });

  test("rejects ciphertext bound to a different backup row", async () => {
    const sealed = await encryptAgentBackupStateData(ORG, BACKUP_ID, sampleState());
    await expect(decryptAgentBackupStateData(BACKUP_ID_B, sealed)).rejects.toThrow();
  });

  test("double-encrypt is a no-op and decrypt of plaintext is a no-op", async () => {
    const state = sampleState();
    const sealed = await encryptAgentBackupStateData(ORG, BACKUP_ID, state);
    const again = await encryptAgentBackupStateData(ORG, BACKUP_ID, sealed);
    expect(again).toBe(sealed);
    expect(await decryptAgentBackupStateData(BACKUP_ID, again)).toEqual(state);
    expect(await decryptAgentBackupStateData(BACKUP_ID, state)).toBe(state);
  });
});
