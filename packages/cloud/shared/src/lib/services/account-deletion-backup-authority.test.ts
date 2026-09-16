/**
 * Proves backup deletion inspects and purges both exact provider prefixes
 * without trusting catalogue rows.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentBackupObjectStore,
  AgentBackupObjectStoreRegistry,
  AgentBackupStorageProvider,
} from "../storage/agent-backup-object-store";
import { ObjectLocatorReceipt } from "../storage/object-store";
import { createAccountDeletionBackupAuthority } from "./account-deletion-backup-authority";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const PREFIX = `agent-sandbox-backups/v2/${ORGANIZATION_ID}/`;

function fakeStore(provider: AgentBackupStorageProvider, initialKeys: readonly string[]) {
  const keys = new Set(initialKeys);
  const authority = {
    provider,
    transport: provider === "cloudflare-r2" ? ("worker-r2" as const) : ("s3-compatible" as const),
    endpointAlias: provider === "cloudflare-r2" ? "r2-primary" : "hetzner-secondary",
    endpointIdentityFingerprint: `sha256:${(provider === "cloudflare-r2" ? "a" : "b").repeat(64)}`,
    bucket: `${provider}-bucket`,
    region: provider === "cloudflare-r2" ? "auto" : "fsn1",
  };
  const listKeys = mock(async ({ prefix }: { prefix: string; cursor?: string }) => ({
    keys: [...keys].filter((key) => key.startsWith(prefix)).sort(),
    truncated: false,
  }));
  const head = mock(async (key: string) =>
    keys.has(key)
      ? {
          status: "present" as const,
          locator: new ObjectLocatorReceipt({
            transport: provider === "cloudflare-r2" ? "worker-r2-binding" : "s3-compatible",
            provider: provider === "cloudflare-r2" ? "r2" : "s3",
            endpointAlias: authority.endpointAlias,
            backendIdentityFingerprint: authority.endpointIdentityFingerprint,
            bucket: authority.bucket,
            region: authority.region,
            keyFingerprint: "c".repeat(64),
            version: "generation-1",
            versionSource: "provider",
          }),
          metadata: {
            sizeBytes: 1,
            checksum: { algorithm: "etag" as const, encoding: "opaque" as const, value: "e" },
          },
        }
      : {
          status: "absent" as const,
          locator: new ObjectLocatorReceipt({
            transport: provider === "cloudflare-r2" ? "worker-r2-binding" : "s3-compatible",
            provider: provider === "cloudflare-r2" ? "r2" : "s3",
            endpointAlias: authority.endpointAlias,
            backendIdentityFingerprint: authority.endpointIdentityFingerprint,
            bucket: authority.bucket,
            region: authority.region,
            keyFingerprint: "c".repeat(64),
            version: null,
            versionSource: "none",
          }),
          metadata: null,
        },
  );
  const remove = mock(async ({ key }: { key: string }) => {
    keys.delete(key);
    return {
      status: "deleted" as const,
      locator: (await head(key)).locator,
      metadata: null,
      providerRequestId: null,
      verifiedAbsent: true as const,
    };
  });
  return {
    keys,
    listKeys,
    remove,
    store: {
      authority,
      listKeys,
      head,
      delete: remove,
      getExactObject: mock(() => {
        throw new Error("unused");
      }),
      putImmutable: mock(() => {
        throw new Error("unused");
      }),
    } as AgentBackupObjectStore,
  };
}

function registry(stores: readonly AgentBackupObjectStore[]): AgentBackupObjectStoreRegistry {
  return {
    configuredStores: () => stores,
    forNewObject: (alias) => stores.find((store) => store.authority.endpointAlias === alias)!,
    forStoredObject: (authority) =>
      stores.find((store) => store.authority.endpointAlias === authority.endpointAlias)!,
  };
}

describe("account deletion backup authority composition", () => {
  test("fails closed unless exact primary and secondary stores are present", () => {
    const primary = fakeStore("cloudflare-r2", []);
    expect(() => createAccountDeletionBackupAuthority(registry([primary.store]))).toThrow(
      "exact primary and secondary",
    );
  });

  test("finds orphaned provider objects without a catalogue-row input", async () => {
    const primary = fakeStore("cloudflare-r2", []);
    const secondary = fakeStore("hetzner-object-storage", [
      `${PREFIX}backup/secondary/db/00000000.bin`,
    ]);
    const authority = createAccountDeletionBackupAuthority(
      registry([primary.store, secondary.store]),
    );

    await expect(
      authority.inspectOrganizationBackups({ organizationId: ORGANIZATION_ID }),
    ).resolves.toBe("present");
    expect(primary.listKeys).toHaveBeenCalledWith({ prefix: PREFIX, cursor: undefined });
    expect(secondary.listKeys).toHaveBeenCalledWith({ prefix: PREFIX, cursor: undefined });
  });

  test("purges only the exact organization prefix and then proves absence", async () => {
    const other = "agent-sandbox-backups/v2/20000000-0000-4000-8000-000000000002/backup/x";
    const primary = fakeStore("cloudflare-r2", [`${PREFIX}backup/primary/db/00000000.bin`, other]);
    const secondary = fakeStore("hetzner-object-storage", [
      `${PREFIX}backup/secondary/db/00000000.bin`,
      other,
    ]);
    const authority = createAccountDeletionBackupAuthority(
      registry([primary.store, secondary.store]),
    );

    await authority.purgeOrganizationBackups({
      organizationId: ORGANIZATION_ID,
      idempotencyKey: "account-deletion:request:secondary-backups",
    });

    await expect(
      authority.inspectOrganizationBackups({ organizationId: ORGANIZATION_ID }),
    ).resolves.toBe("absent");
    expect(primary.keys).toEqual(new Set([other]));
    expect(secondary.keys).toEqual(new Set([other]));
  });
});
