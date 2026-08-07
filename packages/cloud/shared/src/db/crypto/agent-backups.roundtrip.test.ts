// Full encrypt → persist-shape → restore roundtrip for agent backup state
// under the org DEK, exercising the REAL production path: agent-backups →
// field-crypto → kms-client → core LocalKmsAdapter (the backend
// prod and staging run). The durability properties asserted here are exactly
// the ones the #15310 staging incident violated:
//
//   1. a backup written before a worker restart must decrypt after it
//      (same ELIZA_LOCAL_ROOT_KEY → HKDF re-derives the same org DEK), and
//   2. a backup written under a DIFFERENT root key (the ephemeral memory
//      backend rotating on every boot) must fail CLOSED — an error, never
//      silently-wrong plaintext.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runWithCloudBindings } from "../../lib/runtime/cloud-bindings";
import type { AgentBackupStateData } from "../schemas/agent-sandboxes";
import {
  decryptAgentBackupStateData,
  encryptAgentBackupStateData,
  isEncryptedAgentBackupStateData,
} from "./agent-backups";
import { resetKmsClientForTests } from "./kms-client";

const ROOT_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const ROTATED_ROOT_KEY = Buffer.from(new Uint8Array(32).fill(8)).toString("base64");

const ORG_ID = "org-roundtrip-test";
const BACKUP_ID = "backup-0001";

/** Prod-like env: local KMS backend with a persistent root key. */
function prodEnv(rootKey: string): Record<string, string> {
  return {
    ENVIRONMENT: "production",
    ELIZA_KMS_BACKEND: "local",
    ELIZA_LOCAL_ROOT_KEY: rootKey,
  };
}

function sampleState(): AgentBackupStateData {
  return {
    memories: [
      { role: "user", text: "remember the launch date", timestamp: 1751932800000 },
      { role: "assistant", text: "Launch is 2026-07-15.", timestamp: 1751932860000 },
    ],
    config: { name: "Test Agent", plugins: ["plugin-sql"], nested: { a: [1, 2, 3] } },
    workspaceFiles: { "notes.md": "# notes\nhello", ".eliza/eliza.json": "{}" },
  };
}

beforeEach(() => {
  resetKmsClientForTests();
});

afterEach(() => {
  resetKmsClientForTests();
});

describe("agent backup state encrypt→restore roundtrip (org DEK, local KMS)", () => {
  test("roundtrip returns the exact original state", async () => {
    const state = sampleState();
    const stored = await runWithCloudBindings(prodEnv(ROOT_KEY), () =>
      encryptAgentBackupStateData(ORG_ID, BACKUP_ID, state),
    );

    // The stored value must be the sealed envelope, never plaintext.
    expect(isEncryptedAgentBackupStateData(stored)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("remember the launch date");

    const restored = await runWithCloudBindings(prodEnv(ROOT_KEY), () =>
      decryptAgentBackupStateData(BACKUP_ID, stored),
    );
    expect(restored).toEqual(state);
  });

  test("a backup survives a worker restart (fresh KMS client, same root key)", async () => {
    const state = sampleState();
    const stored = await runWithCloudBindings(prodEnv(ROOT_KEY), () =>
      encryptAgentBackupStateData(ORG_ID, BACKUP_ID, state),
    );

    // Simulate the restart: drop the KMS singleton so the next call re-resolves
    // a brand-new client from env — the only continuity is the root key itself.
    resetKmsClientForTests();

    const restored = await runWithCloudBindings(prodEnv(ROOT_KEY), () =>
      decryptAgentBackupStateData(BACKUP_ID, stored),
    );
    expect(restored).toEqual(state);
  });

  test("a rotated/lost root key fails CLOSED (the memory-KMS incident shape)", async () => {
    const stored = await runWithCloudBindings(prodEnv(ROOT_KEY), () =>
      encryptAgentBackupStateData(ORG_ID, BACKUP_ID, sampleState()),
    );

    resetKmsClientForTests();

    // A different root key derives a different org DEK — decrypt must throw
    // (AEAD auth failure), never return wrong plaintext.
    await expect(
      runWithCloudBindings(prodEnv(ROTATED_ROOT_KEY), () =>
        decryptAgentBackupStateData(BACKUP_ID, stored),
      ),
    ).rejects.toThrow();
  });

  test("tampered ciphertext fails closed", async () => {
    const stored = await runWithCloudBindings(prodEnv(ROOT_KEY), () =>
      encryptAgentBackupStateData(ORG_ID, BACKUP_ID, sampleState()),
    );
    if (!isEncryptedAgentBackupStateData(stored)) throw new Error("expected envelope");

    const bytes = Buffer.from(stored.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered = { ...stored, ciphertext: bytes.toString("base64") };

    await expect(
      runWithCloudBindings(prodEnv(ROOT_KEY), () =>
        decryptAgentBackupStateData(BACKUP_ID, tampered),
      ),
    ).rejects.toThrow();
  });

  test("ciphertext is bound to its backup row (AAD) — cross-row swap fails closed", async () => {
    const stored = await runWithCloudBindings(prodEnv(ROOT_KEY), () =>
      encryptAgentBackupStateData(ORG_ID, BACKUP_ID, sampleState()),
    );

    // Same org, same key — but presented as a DIFFERENT backup row. The
    // table|rowId|column AAD must reject the swap.
    await expect(
      runWithCloudBindings(prodEnv(ROOT_KEY), () =>
        decryptAgentBackupStateData("backup-9999", stored),
      ),
    ).rejects.toThrow();
  });

  test("both directions are idempotent (double-encrypt / plaintext-decrypt pass through)", async () => {
    const state = sampleState();
    const stored = await runWithCloudBindings(prodEnv(ROOT_KEY), () =>
      encryptAgentBackupStateData(ORG_ID, BACKUP_ID, state),
    );

    // Encrypting an already-sealed envelope is a no-op (same object back).
    const doubleSealed = await runWithCloudBindings(prodEnv(ROOT_KEY), () =>
      encryptAgentBackupStateData(ORG_ID, BACKUP_ID, stored),
    );
    expect(doubleSealed).toBe(stored);

    // Decrypting plaintext (legacy pre-encryption rows) passes through.
    const passthrough = await runWithCloudBindings(prodEnv(ROOT_KEY), () =>
      decryptAgentBackupStateData(BACKUP_ID, state),
    );
    expect(passthrough).toBe(state);
  });
});
