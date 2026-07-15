/** Credit mutations must invalidate every balance view, including inference admission. */

import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { cache } from "./client";
import { CacheKeys } from "./keys";
import { memoryCache } from "./memory-cache";

const deleted: string[] = [];
const deletedPatterns: string[] = [];
const memoryInvalidations: string[] = [];

const delSpy = spyOn(cache, "del").mockImplementation(async (key: string) => {
  deleted.push(key);
});
const delPatternSpy = spyOn(cache, "delPattern").mockImplementation(async (pattern: string) => {
  deletedPatterns.push(pattern);
});
const invalidateOrganizationSpy = spyOn(memoryCache, "invalidateOrganization").mockImplementation(
  async (organizationId: string) => {
    memoryInvalidations.push(`organization:${organizationId}`);
  },
);
const invalidateRoomSpy = spyOn(memoryCache, "invalidateRoom").mockImplementation(
  async (roomId: string, organizationId: string) => {
    memoryInvalidations.push(`room:${roomId}:${organizationId}`);
  },
);
const invalidateMemorySpy = spyOn(memoryCache, "invalidateMemory").mockImplementation(
  async (memoryId: string) => {
    memoryInvalidations.push(`memory:${memoryId}`);
  },
);
const invalidateConversationSpy = spyOn(memoryCache, "invalidateConversation").mockImplementation(
  async (conversationId: string) => {
    memoryInvalidations.push(`conversation:${conversationId}`);
  },
);

const { CacheInvalidation } = await import("./invalidation");

afterAll(() => {
  delSpy.mockRestore();
  delPatternSpy.mockRestore();
  invalidateOrganizationSpy.mockRestore();
  invalidateRoomSpy.mockRestore();
  invalidateMemorySpy.mockRestore();
  invalidateConversationSpy.mockRestore();
});

function resetObservations(): void {
  deleted.length = 0;
  deletedPatterns.length = 0;
  memoryInvalidations.length = 0;
}

beforeEach(resetObservations);

test("onCreditMutation drops the optimistic inference balance hint", async () => {
  const organizationId = "org-credit-mutation";

  await CacheInvalidation.onCreditMutation(organizationId);

  expect(deleted).toContain(CacheKeys.inference.orgBalance(organizationId));
  expect(deleted).toContain(CacheKeys.org.credits(organizationId));
  expect(deleted).toContain(CacheKeys.eliza.orgBalance(organizationId));
});

test("each central invalidation method targets only its own cache scope", async () => {
  const organizationId = "org-invalidation-contract";

  await CacheInvalidation.onUsageRecordCreated(organizationId);
  expect(deleted).toEqual([CacheKeys.org.dashboard(organizationId)]);
  expect(deletedPatterns).toEqual([`analytics:overview:${organizationId}:*`]);

  resetObservations();
  await CacheInvalidation.onGenerationCreated(organizationId);
  expect(deleted).toEqual([CacheKeys.org.dashboard(organizationId)]);

  resetObservations();
  await CacheInvalidation.onOrganizationUpdated(organizationId);
  expect(deleted).toEqual([
    CacheKeys.org.data(organizationId),
    CacheKeys.org.dashboard(organizationId),
  ]);

  resetObservations();
  await CacheInvalidation.clearAll(organizationId);
  expect(deletedPatterns).toEqual([
    CacheKeys.org.pattern(organizationId),
    CacheKeys.analytics.pattern(organizationId),
  ]);
  expect(memoryInvalidations).toEqual([`organization:${organizationId}`]);

  resetObservations();
  await CacheInvalidation.onMemoryCreated(organizationId);
  expect(memoryInvalidations).toEqual([]);

  await CacheInvalidation.onMemoryCreated(organizationId, "room-1");
  expect(memoryInvalidations).toEqual([`room:room-1:${organizationId}`]);

  resetObservations();
  await CacheInvalidation.onMemoryDeleted(organizationId, "memory-1");
  expect(memoryInvalidations).toEqual(["memory:memory-1"]);

  resetObservations();
  await CacheInvalidation.onConversationUpdated("conversation-1");
  expect(memoryInvalidations).toEqual(["conversation:conversation-1"]);
});
