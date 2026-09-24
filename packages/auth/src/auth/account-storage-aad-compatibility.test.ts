/** Exercises historical and consolidated encrypted account envelopes through real storage, migration and refresh; keys are isolated and provider calls are unnecessary. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as crypto from "../vault/crypto.js";
import {
  type AccountCredentialRecord,
  createIsolatedAccountStoragePolicy,
  listAccounts,
  loadAccount,
  saveAccount,
  updateAccountCredentialsIfUnchanged,
} from "./account-storage.ts";

const roots: string[] = [];
const historicalPrefix = "@elizaos/auth/account";
const consolidatedPrefix = "@elizaos/credentials/auth/account";
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-aad-compat-"));
  roots.push(root);
  const policy = createIsolatedAccountStoragePolicy(root);
  // Observe the actual isolated key to produce an authenticated historical fixture.
  const encryption = vi.spyOn(crypto, "encrypt");
  const saved = saveAccount(
    {
      id: "default",
      providerId: "openai-codex",
      source: "oauth",
      label: "Synthetic",
      credentials: {
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    },
    policy,
  );
  const call = encryption.mock.calls.at(-1);
  if (!call) throw new Error("Missing isolated encrypted write");
  const key = call[0];
  encryption.mockRestore();
  const file = path.join(root, "auth", "openai-codex", "default.json");
  const write = (record: AccountCredentialRecord, aad: string) => {
    const envelope = {
      schemaVersion: 2,
      ciphertext: crypto.encrypt(key, JSON.stringify(record), aad),
    };
    fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
    return envelope;
  };
  return { policy, saved, key, file, write };
}

for (const prefix of [historicalPrefix, consolidatedPrefix]) {
  describe(`authenticated account compatibility: ${prefix}`, () => {
    it.each([false, true])(
      "loads and canonically rewrites an encrypted record (generation present: %s)",
      (hasGeneration) => {
        const { policy, saved, key, file, write } = fixture();
        const { credentialGeneration, ...legacy } = saved;
        write(hasGeneration ? saved : legacy, `${prefix}/openai-codex/default`);
        const records = listAccounts("openai-codex", policy);
        const loaded = loadAccount("openai-codex", "default", policy);
        if (!loaded) throw new Error("Account disappeared during migration");
        expect(records[0]?.credentials).toEqual(saved.credentials);
        expect(loaded.credentials).toEqual(saved.credentials);
        if (hasGeneration)
          expect(loaded.credentialGeneration).toBe(credentialGeneration);
        const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
        expect(
          JSON.parse(
            crypto.decrypt(
              key,
              envelope.ciphertext,
              `${historicalPrefix}/openai-codex/default`,
            ),
          ),
        ).toEqual(loaded);
        const persisted = fs.readFileSync(file, "utf8");
        loadAccount("openai-codex", "default", policy);
        expect(fs.readFileSync(file, "utf8")).toBe(persisted);
        expect(
          updateAccountCredentialsIfUnchanged(
            "openai-codex",
            "default",
            loaded.credentialGeneration,
            {
              access: "refreshed-access",
              refresh: "rotated-refresh",
              expires: 2,
            },
            policy,
          ).kind,
        ).toBe("updated");
        const refreshed = JSON.parse(fs.readFileSync(file, "utf8"));
        expect(
          JSON.parse(
            crypto.decrypt(
              key,
              refreshed.ciphertext,
              `${historicalPrefix}/openai-codex/default`,
            ),
          ).credentials.refresh,
        ).toBe("rotated-refresh");
      },
    );

    it("rejects authenticated-envelope tampering without rewriting bytes", () => {
      const { policy, saved, file, write } = fixture();
      const envelope = write(saved, `${prefix}/openai-codex/default`);
      const fields = envelope.ciphertext.split(":");
      const encodedTag = fields[2];
      if (encodedTag === undefined)
        throw new Error("Missing authentication tag");
      const tag = Buffer.from(encodedTag, "base64");
      const firstByte = tag[0];
      if (firstByte === undefined) throw new Error("Empty authentication tag");
      tag[0] = firstByte ^ 1;
      fields[2] = tag.toString("base64");
      const tampered = JSON.stringify({
        ...envelope,
        ciphertext: fields.join(":"),
      });
      fs.writeFileSync(file, tampered);
      expect(() => loadAccount("openai-codex", "default", policy)).toThrow(
        expect.objectContaining({ code: "AUTH_CREDENTIAL_RECORD_CORRUPT" }),
      );
      expect(fs.readFileSync(file, "utf8")).toBe(tampered);
    });

    it.each(["openai-codex/another-account", "anthropic-subscription/default"])(
      "rejects ciphertext bound to another identity: %s",
      (identity) => {
        const { policy, saved, file, write } = fixture();
        write(saved, `${prefix}/${identity}`);
        const before = fs.readFileSync(file, "utf8");
        expect(() => loadAccount("openai-codex", "default", policy)).toThrow(
          expect.objectContaining({ code: "AUTH_CREDENTIAL_RECORD_CORRUPT" }),
        );
        expect(fs.readFileSync(file, "utf8")).toBe(before);
      },
    );

    it("rejects a decrypted payload whose account identity disagrees with its path", () => {
      const { policy, saved, write } = fixture();
      write(
        { ...saved, id: "different-account" },
        `${prefix}/openai-codex/default`,
      );
      expect(() => loadAccount("openai-codex", "default", policy)).toThrow(
        expect.objectContaining({ code: "AUTH_CREDENTIAL_RECORD_CORRUPT" }),
      );
    });
  });
}
