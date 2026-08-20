/** Proves ordered, fail-closed account resource purging and exhaustive R2 cleanup. */

import { describe, expect, mock, test } from "bun:test";
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import {
  type AccountDeletionResourcePurgeDependencies,
  purgeOrganizationObjectStorage,
  purgePersonalOrganizationResources,
} from "./account-deletion-resource-purge";

const organizationId = "11111111-1111-4111-8111-111111111111";

function fakeBucket(overrides: Partial<RuntimeR2Bucket> = {}): RuntimeR2Bucket {
  return {
    get: mock(async () => null),
    put: mock(async () => undefined),
    delete: mock(async () => undefined),
    list: mock(async () => ({ objects: [], truncated: false })),
    ...overrides,
  };
}

function orderedDependencies(
  events: string[],
  overrides: Partial<AccountDeletionResourcePurgeDependencies> = {},
): AccountDeletionResourcePurgeDependencies {
  return {
    disableBilling: mock(async () => {
      events.push("disable-billing");
      return "cus_123";
    }),
    deleteBillingCustomer: mock(async () => {
      events.push("delete-customer");
    }),
    prepareManagedDomains: mock(async () => {
      events.push("prepare-domains");
    }),
    listAgentIds: mock(async () => ["agent-1", "agent-2"]),
    deleteAgent: mock(async (id) => {
      events.push(`delete-${id}`);
    }),
    listAppIds: mock(async () => ["app-1"]),
    deleteApp: mock(async (id) => {
      events.push(`delete-${id}`);
    }),
    listActiveVoiceIds: mock(async () => ["voice-1"]),
    deleteVoice: mock(async (id) => {
      events.push(`delete-${id}`);
    }),
    purgeObjectStorage: mock(async () => {
      events.push("delete-r2");
      return 4;
    }),
    ...overrides,
  };
}

describe("personal organization resource purge", () => {
  test("deletes billing, agents, apps, voices, and objects in strict order", async () => {
    const events: string[] = [];
    await purgePersonalOrganizationResources({
      organizationId,
      blob: fakeBucket(),
      dependencies: orderedDependencies(events),
    });

    expect(events).toEqual([
      "disable-billing",
      "delete-customer",
      "prepare-domains",
      "delete-agent-1",
      "delete-agent-2",
      "delete-app-1",
      "delete-voice-1",
      "delete-r2",
    ]);
  });

  test("does not run later destructive phases after a provider failure", async () => {
    const events: string[] = [];
    const dependencies = orderedDependencies(events, {
      deleteAgent: mock(async (id) => {
        events.push(`delete-${id}`);
        throw new Error("container unavailable");
      }),
    });

    await expect(
      purgePersonalOrganizationResources({
        organizationId,
        blob: fakeBucket(),
        dependencies,
      }),
    ).rejects.toThrow("container unavailable");
    expect(events).toEqual([
      "disable-billing",
      "delete-customer",
      "prepare-domains",
      "delete-agent-1",
    ]);
    expect(dependencies.deleteApp).not.toHaveBeenCalled();
    expect(dependencies.purgeObjectStorage).not.toHaveBeenCalled();
  });

  test("stops before hosted-resource destruction when a registered domain needs transfer", async () => {
    const events: string[] = [];
    const dependencies = orderedDependencies(events, {
      prepareManagedDomains: mock(async () => {
        events.push("prepare-domains");
        throw new Error("registered domain requires transfer");
      }),
    });

    await expect(
      purgePersonalOrganizationResources({
        organizationId,
        blob: fakeBucket(),
        dependencies,
      }),
    ).rejects.toThrow("requires transfer");
    expect(events).toEqual(["disable-billing", "delete-customer", "prepare-domains"]);
    expect(dependencies.deleteAgent).not.toHaveBeenCalled();
  });
});

describe("organization R2 purge", () => {
  test("paginates and deletes only objects owned by the exact organization", async () => {
    const deleted: string[] = [];
    const list = mock(async (options?: { cursor?: string }) =>
      options?.cursor
        ? {
            objects: [
              {
                key: `backups/${organizationId}/agent.tar`,
                size: 1,
                etag: "c",
              },
              {
                key: `backups/prefix-${organizationId}-suffix/keep.tar`,
                size: 1,
                etag: "d",
              },
            ],
            truncated: false,
          }
        : {
            objects: [
              {
                key: "avatars/opaque.webp",
                size: 1,
                etag: "a",
                customMetadata: { organizationId },
              },
              {
                key: "avatars/other.webp",
                size: 1,
                etag: "b",
                customMetadata: { organizationId: "22222222-2222-4222-8222-222222222222" },
              },
            ],
            truncated: true,
            cursor: "next",
          },
    );
    const bucket = fakeBucket({
      list,
      delete: mock(async (key) => {
        deleted.push(key);
      }),
    });

    await expect(purgeOrganizationObjectStorage(bucket, organizationId)).resolves.toBe(2);
    expect(deleted).toEqual(["avatars/opaque.webp", `backups/${organizationId}/agent.tar`]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("fails closed when an R2 listing cursor repeats", async () => {
    const bucket = fakeBucket({
      list: mock(async () => ({ objects: [], truncated: true, cursor: "same" })),
    });

    await expect(purgeOrganizationObjectStorage(bucket, organizationId)).rejects.toThrow(
      "invalid cursor",
    );
  });
});
