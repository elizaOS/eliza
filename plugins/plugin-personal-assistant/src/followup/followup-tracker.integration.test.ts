/** Hourly follow-up ticks keep one open approval per overdue contact, through the real queue and PGlite migrations. */

import type { UUID } from "@elizaos/core";
import { createApprovalQueue } from "@elizaos/plugin-assistant";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import {
  FOLLOWUP_TRACKER_INTERVAL_MS,
  reconcileFollowupsOnce,
} from "./followup-tracker.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const contactId = "00000000-0000-4000-8000-0000000a0001" as UUID;

let host: RealTestRuntimeResult;
beforeAll(async () => {
  host = await createLifeOpsTestRuntime();
}, 60_000);
afterAll(async () => {
  await host.cleanup();
});

it("does not raise a second approval for a contact whose follow-up approval is still open", async () => {
  const now = Date.now();
  const relationships = {
    searchContacts: async () => [
      {
        entityId: contactId,
        categories: [],
        tags: [],
        customFields: {
          displayName: "Ann",
          lastContactedAt: new Date(now - 40 * DAY_MS).toISOString(),
        },
      },
    ],
    getContact: async () => null,
    updateContact: async () => null,
  };
  const getService = host.runtime.getService.bind(host.runtime);
  vi.spyOn(host.runtime, "getService").mockImplementation(((name: string) =>
    name === "relationships"
      ? relationships
      : getService(name)) as typeof host.runtime.getService);
  let draft = 0;
  vi.spyOn(host.runtime, "useModel").mockImplementation((async () => {
    draft += 1;
    return JSON.stringify({
      action: "send_email",
      channel: "email",
      requiresApproval: true,
      reason: "Ann is overdue for a follow-up.",
      payload: {
        to: ["ann@example.test"],
        subject: "Catching up",
        body: `Draft ${draft}: it has been a while, how are you?`,
      },
    });
  }) as typeof host.runtime.useModel);

  await reconcileFollowupsOnce(host.runtime, now);
  await reconcileFollowupsOnce(
    host.runtime,
    now + FOLLOWUP_TRACKER_INTERVAL_MS,
  );

  const pending = await createApprovalQueue(host.runtime, {
    agentId: host.runtime.agentId,
  }).list({ subjectUserId: contactId, state: "pending", action: null });
  expect(pending.map((request) => request.requestedBy)).toEqual([
    "background-job:followup_watchdog",
  ]);
});
