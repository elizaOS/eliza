import type http from "node:http";
import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { ApprovalService, ServiceType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvalTaskToPendingAction,
  handleApprovalRoute,
} from "./approval-routes";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

/**
 * Minimal runtime exposing the `getTasks` query the ApprovalService uses, seeded
 * with a fixed task list. `getTasks` honors the agentIds filter (multi-tenant
 * safety) so the route only ever sees this agent's pending approvals.
 */
async function makeRuntimeWithService(tasks: Task[]): Promise<{
  runtime: { getService: (t: string) => unknown };
  service: ApprovalService;
}> {
  const baseRuntime = {
    agentId: AGENT_ID,
    getTasks: vi.fn(
      async (params: { tags?: string[]; agentIds: UUID[] }): Promise<Task[]> => {
        if (!params.agentIds.includes(AGENT_ID)) return [];
        const wanted = new Set(params.tags ?? []);
        return tasks.filter((task) =>
          [...wanted].every((tag) => task.tags?.includes(tag)),
        );
      },
    ),
  } as unknown as IAgentRuntime;
  const service = (await ApprovalService.start(
    baseRuntime,
  )) as ApprovalService;
  const runtime = {
    getService: (t: string) => (t === ServiceType.APPROVAL ? service : null),
  };
  return { runtime, service };
}

function makeHelpers() {
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn();
  return { json, error, readJsonBody };
}

const req = (url: string) => ({ url }) as http.IncomingMessage;
const res = {} as http.ServerResponse;

function approvalTask(patch: Partial<Task> & { id: string }): Task {
  return {
    id: patch.id as UUID,
    name: patch.name ?? "EXEC_APPROVAL",
    description: patch.description ?? "Run rm -rf /tmp/cache?",
    roomId: (patch.roomId ?? "11111111-1111-1111-1111-111111111111") as UUID,
    tags: patch.tags ?? ["AWAITING_CHOICE", "APPROVAL"],
    createdAt: patch.createdAt ?? 1_000,
    metadata: patch.metadata,
  };
}

describe("approvalTaskToPendingAction", () => {
  it("projects a task into a PendingUserAction with options + createdAt", () => {
    const action = approvalTaskToPendingAction(
      approvalTask({
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        description: "Post this tweet?",
        metadata: {
          options: [
            { name: "approve", description: "Approve the request" },
            { name: "deny", description: "Deny", isCancel: true },
          ],
          approvalRequest: { createdAt: 4_242 },
        },
      }),
    );
    expect(action).not.toBeNull();
    expect(action?.kind).toBe("approval");
    expect(action?.title).toBe("Post this tweet?");
    expect(action?.createdAt).toBe(4_242);
    expect(action?.options).toEqual([
      { name: "approve", description: "Approve the request", isCancel: false },
      { name: "deny", description: "Deny", isCancel: true },
    ]);
  });

  it("drops a malformed task missing id or roomId (no placeholder data)", () => {
    expect(
      approvalTaskToPendingAction({
        name: "X",
        tags: ["APPROVAL"],
      } as Task),
    ).toBeNull();
  });

  it("falls back to the row createdAt and the task name when metadata is absent", () => {
    const action = approvalTaskToPendingAction(
      approvalTask({
        id: "aaaaaaaa-0000-0000-0000-000000000002",
        name: "CONFIRM_123",
        description: "   ",
        createdAt: 999,
      }),
    );
    expect(action?.createdAt).toBe(999);
    expect(action?.title).toBe("CONFIRM_123");
    expect(action?.options).toBeUndefined();
  });
});

describe("handleApprovalRoute", () => {
  let runtime: { getService: (t: string) => unknown };

  beforeEach(async () => {
    ({ runtime } = await makeRuntimeWithService([
      approvalTask({
        id: "aaaaaaaa-0000-0000-0000-000000000010",
        description: "Older request",
        createdAt: 1_000,
      }),
      approvalTask({
        id: "aaaaaaaa-0000-0000-0000-000000000011",
        description: "Newer request",
        createdAt: 5_000,
        metadata: { approvalRequest: { createdAt: 5_000 } },
      }),
      // A non-approval task in the store must NOT leak into the surface.
      approvalTask({
        id: "aaaaaaaa-0000-0000-0000-000000000012",
        description: "unrelated",
        tags: ["SOME_OTHER_TAG"],
      }),
    ]));
  });

  it("ignores non-approval paths", async () => {
    const helpers = makeHelpers();
    const handled = await handleApprovalRoute(
      req("/api/other"),
      res,
      "/api/other",
      "GET",
      { runtime },
      helpers,
    );
    expect(handled).toBe(false);
  });

  it("GET returns pending approvals newest-first as PendingUserAction[]", async () => {
    const helpers = makeHelpers();
    await handleApprovalRoute(
      req("/api/approvals"),
      res,
      "/api/approvals",
      "GET",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledTimes(1);
    const payload = helpers.json.mock.calls[0][1] as {
      pending: Array<{ id: string; title: string; kind: string }>;
    };
    expect(payload.pending.map((p) => p.title)).toEqual([
      "Newer request",
      "Older request",
    ]);
    expect(payload.pending.every((p) => p.kind === "approval")).toBe(true);
  });

  it("rejects non-GET methods with 404", async () => {
    const helpers = makeHelpers();
    await handleApprovalRoute(
      req("/api/approvals"),
      res,
      "/api/approvals",
      "POST",
      { runtime },
      helpers,
    );
    expect(helpers.error).toHaveBeenCalledWith(res, expect.any(String), 404);
  });

  it("serves an empty surface when the approval service is not registered", async () => {
    const helpers = makeHelpers();
    const emptyRuntime = { getService: () => null };
    await handleApprovalRoute(
      req("/api/approvals"),
      res,
      "/api/approvals",
      "GET",
      { runtime: emptyRuntime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, { pending: [] });
  });
});
