/** The approval queue's list excludes an action before its limit, through the real queue and PGlite migrations. */

import type { ApprovalEnqueueInput } from "@elizaos/plugin-assistant";
import { createApprovalQueue } from "@elizaos/plugin-assistant";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { executeRawSql, sqlText } from "./sql.js";

let host: RealTestRuntimeResult;
beforeAll(async () => {
  host = await createLifeOpsTestRuntime();
}, 60_000);
afterAll(async () => {
  await host.cleanup();
});

function email(owner: string, subject: string): ApprovalEnqueueInput {
  return {
    requestedBy: owner,
    subjectUserId: owner,
    action: "send_email",
    channel: "email",
    reason: "Synthetic approval",
    expiresAt: new Date(Date.now() + 86_400_000),
    payload: {
      action: "send_email",
      to: ["self@example.test"],
      cc: [],
      bcc: [],
      subject,
      body: "No provider dispatch",
      threadId: null,
      replyToMessageId: null,
    },
  };
}

it("returns an older approval behind newer excluded device actions", async () => {
  const owner = "exclude-owner";
  const queue = createApprovalQueue(host.runtime, {
    agentId: host.runtime.agentId,
  });
  const kept = await queue.enqueue(email(owner, "Older email"));
  await executeRawSql(
    host.runtime,
    `UPDATE approval_requests SET created_at = '2026-10-01T00:00:00Z' WHERE id = ${sqlText(kept.id)}`,
  );
  for (let index = 0; index < 3; index += 1) {
    const device = await queue.enqueue(email(owner, `Device ${index}`));
    await executeRawSql(
      host.runtime,
      `UPDATE approval_requests
          SET action = 'device_action',
              created_at = '2026-10-0${index + 2}T00:00:00Z'
        WHERE id = ${sqlText(device.id)}`,
    );
  }

  const listed = await queue.list({
    subjectUserId: owner,
    state: "pending",
    action: null,
    excludeAction: "device_action",
    limit: 2,
  });

  expect(listed.map((request) => request.id)).toEqual([kept.id]);
});
