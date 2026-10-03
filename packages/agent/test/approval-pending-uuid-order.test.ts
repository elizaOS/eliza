/**
 * Pending approvals are newest-first. Two requests created in the same
 * millisecond must surface the higher UUID first.
 */
import type http from "node:http";
import { ServiceType, type UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  type ApprovalRouteState,
  handleApprovalRoute,
} from "../src/api/approval-routes.ts";

const LOWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const UPPER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const ROOM = "22222222-2222-4222-8222-222222222222" as UUID;
const SAME = 1_700_000_000_000;

function task(id: UUID) {
  return {
    id,
    name: "APPROVAL",
    roomId: ROOM,
    createdAt: SAME,
    metadata: { approvalRequest: { createdAt: SAME } },
  };
}

describe("pending approval UUID ties", () => {
  it("lists the higher UUID first when two pending tasks share a millisecond", async () => {
    let body = "";
    const req = { url: "/api/approvals" } as http.IncomingMessage;
    const res = {
      setHeader() {},
      end(chunk?: string) {
        body = chunk ?? "";
      },
    } as unknown as http.ServerResponse;
    const state: ApprovalRouteState = {
      runtime: {
        agentId: "11111111-1111-4111-8111-111111111111",
        getService(type: string) {
          if (type !== ServiceType.APPROVAL) return null;
          return {
            getAllPendingApprovals: async () => [task(LOWER), task(UPPER)],
          };
        },
      },
    };

    const handled = await handleApprovalRoute(
      req,
      res,
      "/api/approvals",
      "GET",
      state,
      {
        json(_res, data) {
          body = JSON.stringify(data);
        },
        error() {
          throw new Error("unexpected approval error");
        },
        readJsonBody: async () => null,
      },
    );

    expect(handled).toBe(true);
    const pending = JSON.parse(body).pending as Array<{ id: string }>;
    expect(pending.map((action) => action.id)).toEqual([UPPER, LOWER]);
  });
});
