import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, expect, it, vi } from "vitest";
import { readApprovalRequestsForOriginalSources } from "./store.ts";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("./sql.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeRawSql: mocks.execute,
}));
const runtime = { agentId: "owner-agent" } as IAgentRuntime;
beforeEach(() => {
  mocks.execute.mockReset();
  mocks.execute.mockResolvedValue([]);
});
it("binds each proposal to its original message and the current agent without a subject-wide scan", async () => {
  await readApprovalRequestsForOriginalSources(runtime, [
    { proposalId: "proposal-A", requestMessageId: "message-A" },
    { proposalId: "proposal-B", requestMessageId: "message-B" },
  ]);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  const query = mocks.execute.mock.calls[0][1];
  expect(query).toContain("agent_id = 'owner-agent'");
  expect(query).toContain("requested_by = 'owner-agent'");
  expect(query).toContain("action = 'device_action'");
  expect(query).toContain(
    "(id = 'proposal-A' AND payload->>'requestMessageId' = 'message-A')",
  );
  expect(query).toContain(
    "(id = 'proposal-B' AND payload->>'requestMessageId' = 'message-B')",
  );
});
it("does not access storage with no references and quotes identifiers as SQL values", async () => {
  expect(await readApprovalRequestsForOriginalSources(runtime, [])).toEqual([]);
  expect(mocks.execute).not.toHaveBeenCalled();
  await readApprovalRequestsForOriginalSources(runtime, [
    { proposalId: "proposal'quoted", requestMessageId: "message'quoted" },
  ]);
  expect(mocks.execute.mock.calls[0][1]).toContain("id = 'proposal''quoted'");
  expect(mocks.execute.mock.calls[0][1]).toContain(
    "requestMessageId' = 'message''quoted'",
  );
});
