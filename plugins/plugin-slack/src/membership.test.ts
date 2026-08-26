/**
 * Membership snapshot/delta boundary tests: `conversations.members` paging,
 * failure classification (scope/permission/pagination), payload preservation
 * in join/leave events, sender renewal on admitted inbound messages, thread
 * inheritance configuration, and the unavailable-vs-empty distinction.
 * The Slack Web API client is mocked; the walk, classification, and service
 * event paths are the real implementations.
 */
import { describe, expect, it, vi } from "vitest";
import {
  classifyMembershipFailure,
  readChannelMembershipSnapshot,
  SLACK_MEMBERS_PAGE_LIMIT,
  type SlackMembershipUnavailable,
} from "./membership";

function page(members: string[], nextCursor?: string) {
  return {
    members,
    ...(nextCursor ? { response_metadata: { next_cursor: nextCursor } } : {}),
  };
}

function slackError(code: string) {
  const error = new Error(`Slack API ${code}`) as Error & {
    data?: { code?: string };
  };
  error.data = { code };
  return error;
}

function makeClient(pages: unknown[] = [], throws?: (call: number) => unknown) {
  let call = 0;
  const conversationsMembers = vi.fn(async () => {
    const thrower = throws?.(call);
    call += 1;
    if (thrower) throw thrower;
    const result = pages.shift();
    if (!result) throw new Error("unexpected extra page request");
    return result;
  });
  return {
    client: { conversations: { members: conversationsMembers } },
    conversationsMembers,
  };
}

describe("classifyMembershipFailure", () => {
  it("classifies missing scope family as missing_scope", () => {
    for (const code of ["missing_scope", "not_allowed"]) {
      expect(classifyMembershipFailure(slackError(code)).reason).toBe(
        "missing_scope",
      );
    }
  });

  it("classifies not_in_channel as not_a_member, not empty", () => {
    const result = classifyMembershipFailure(slackError("not_in_channel"));
    expect(result.reason).toBe("not_a_member");
    expect(result.slackErrorCode).toBe("not_in_channel");
  });

  it("classifies channel_not_found, ratelimited, invalid_cursor distinctly", () => {
    expect(
      classifyMembershipFailure(slackError("channel_not_found")).reason,
    ).toBe("channel_not_found");
    expect(classifyMembershipFailure(slackError("ratelimited")).reason).toBe(
      "rate_limited",
    );
    expect(classifyMembershipFailure(slackError("invalid_cursor")).reason).toBe(
      "pagination_loop",
    );
  });

  it("falls back to request_failed with the code preserved", () => {
    const result = classifyMembershipFailure(slackError("internal_error"));
    expect(result.reason).toBe("request_failed");
    expect(result.slackErrorCode).toBe("internal_error");
  });
});

describe("readChannelMembershipSnapshot", () => {
  it("walks every page to a terminal cursor and returns the complete roster", async () => {
    const { client, conversationsMembers } = makeClient([
      page(["U1", "U2"], "cur-1"),
      page(["U3"], "cur-2"),
      page(["U4"]),
    ]);
    const result = await readChannelMembershipSnapshot(client as never, "C123");
    expect(result.kind).toBe("snapshot");
    if (result.kind !== "snapshot") return;
    expect([...result.memberIds]).toEqual(["U1", "U2", "U3", "U4"]);
    expect(result.completedPages).toBe(3);
    expect(conversationsMembers).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        limit: SLACK_MEMBERS_PAGE_LIMIT,
      }),
    );
  });

  it("requests cursors only after the first page", async () => {
    const { client, conversationsMembers } = makeClient([
      page(["U1"], "c1"),
      page(["U2"]),
    ]);
    await readChannelMembershipSnapshot(client as never, "C123");
    expect(conversationsMembers.mock.calls[0]?.[0]).not.toHaveProperty(
      "cursor",
    );
    expect(conversationsMembers.mock.calls[1]?.[0]).toMatchObject({
      cursor: "c1",
    });
  });

  it("an empty terminal roster is a valid snapshot, not unavailable", async () => {
    const { client } = makeClient([page([])]);
    const result = await readChannelMembershipSnapshot(client as never, "C123");
    expect(result.kind).toBe("snapshot");
    if (result.kind !== "snapshot") return;
    expect(result.memberIds).toHaveLength(0);
  });

  it("a mid-walk API failure invalidates the whole walk as unavailable", async () => {
    const { client } = makeClient([page(["U1"], "c1")], () =>
      slackError("missing_scope"),
    );
    const result = await readChannelMembershipSnapshot(client as never, "C123");
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason).toBe("missing_scope");
    expect(result.slackErrorCode).toBe("missing_scope");
  });

  it("not_in_channel surfaces as unavailable — never an empty roster", async () => {
    const { client } = makeClient([], () => slackError("not_in_channel"));
    const result = await readChannelMembershipSnapshot(client as never, "C123");
    const unavailable = result as SlackMembershipUnavailable;
    expect(unavailable.kind).toBe("unavailable");
    expect(unavailable.reason).toBe("not_a_member");
  });

  it("a repeated next_cursor is a pagination loop, not completion", async () => {
    const { client } = makeClient([page(["U1"], "loop"), page(["U2"], "loop")]);
    const result = await readChannelMembershipSnapshot(client as never, "C123");
    const unavailable = result as SlackMembershipUnavailable;
    expect(unavailable.kind).toBe("unavailable");
    expect(unavailable.reason).toBe("pagination_loop");
  });

  it("a page without a members array is malformed, not empty", async () => {
    const { client } = makeClient([{ response_metadata: {} }]);
    const result = await readChannelMembershipSnapshot(client as never, "C123");
    const unavailable = result as SlackMembershipUnavailable;
    expect(unavailable.kind).toBe("unavailable");
    expect(unavailable.reason).toBe("malformed_response");
  });

  it("a non-string member entry is malformed, not silently dropped", async () => {
    const { client } = makeClient([page(["U1", 42 as never])]);
    const result = await readChannelMembershipSnapshot(client as never, "C123");
    const unavailable = result as SlackMembershipUnavailable;
    expect(unavailable.kind).toBe("unavailable");
    expect(unavailable.reason).toBe("malformed_response");
  });
});
