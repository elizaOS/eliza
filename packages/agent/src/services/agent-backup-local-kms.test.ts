/** Local backup encryption resolves a usable KMS for an unconfigured local agent and keeps explicit KMS selections. */
import { randomBytes } from "node:crypto";
import { systemKey } from "@elizaos/auth/kms";
import { inMemoryMasterKey } from "@elizaos/auth/vault";
import { describe, expect, it } from "vitest";
import { createLocalBackupKmsClient } from "./agent-backup.ts";

const aad = new TextEncoder().encode("agent-backup-file|agent|sha");
const plaintext = new TextEncoder().encode("backup payload");

describe("createLocalBackupKmsClient", () => {
  it("seals with the vault master key when no KMS backend is configured", async () => {
    const env = { NODE_ENV: "production" };
    const masterKey = inMemoryMasterKey(randomBytes(32));
    const writer = await createLocalBackupKmsClient(env, masterKey);
    const keyId = systemKey("agent-backup");
    await writer.getOrCreateKey(keyId);
    const sealed = await writer.encrypt(keyId, plaintext, aad);

    // A later process with the same master key opens the same backup.
    const reader = await createLocalBackupKmsClient(env, masterKey);
    const opened = await reader.decrypt(
      sealed.keyId,
      sealed.ciphertext,
      sealed.nonce,
      sealed.authTag,
      aad,
      sealed.keyVersion,
    );
    expect(new TextDecoder().decode(opened)).toBe("backup payload");

    const other = await createLocalBackupKmsClient(
      env,
      inMemoryMasterKey(randomBytes(32)),
    );
    await expect(
      other.decrypt(
        sealed.keyId,
        sealed.ciphertext,
        sealed.nonce,
        sealed.authTag,
        aad,
        sealed.keyVersion,
      ),
    ).rejects.toThrow();
  });

  it("propagates an unavailable master key", async () => {
    await expect(
      createLocalBackupKmsClient(
        { NODE_ENV: "production" },
        {
          load: () => Promise.reject(new Error("keychain locked")),
          describe: () => "unavailable",
        },
      ),
    ).rejects.toThrow("keychain locked");
  });

  it("keeps an explicit KMS backend selection", async () => {
    const unused = {
      load: () => Promise.reject(new Error("master key must not be read")),
      describe: () => "unused",
    };
    await expect(
      createLocalBackupKmsClient(
        { NODE_ENV: "production", ELIZA_KMS_BACKEND: "steward" },
        unused,
      ),
    ).rejects.toThrow("ELIZA_KMS_BACKEND=steward requires");
    await expect(
      createLocalBackupKmsClient(
        {
          NODE_ENV: "production",
          ELIZA_LOCAL_ROOT_KEY: randomBytes(32).toString("base64"),
        },
        unused,
      ),
    ).resolves.toBeDefined();
  });
});
