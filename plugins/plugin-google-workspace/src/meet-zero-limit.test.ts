/**
 * An explicit Meet list limit of 0 is an empty page. A truthy check used to
 * keep paging and then return every participant or session.
 */

import { describe, expect, it, vi } from "vitest";
import type { GoogleApiClientFactory } from "./client-factory.js";
import { GoogleMeetClient } from "./meet.js";

function page(names: string[], nextPageToken?: string) {
  return {
    data: {
      nextPageToken,
      participants: names.map((name) => ({
        name,
        earliestStartTime: "2026-08-13T00:00:00.000Z",
      })),
      participantSessions: names.map((name) => ({
        name,
        startTime: "2026-08-13T00:00:00.000Z",
      })),
    },
  };
}

function clientFor(list: ReturnType<typeof vi.fn>) {
  const meet = {
    conferenceRecords: {
      participants: {
        list,
        participantSessions: { list },
      },
    },
  };
  return new GoogleMeetClient({
    meet: async () => meet,
  } as unknown as GoogleApiClientFactory);
}

describe("Google Meet explicit empty pages", () => {
  it("treats a participant limit of 0 as an empty page and stops paging", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page(["one", "two"], "page-2"))
      .mockResolvedValueOnce(page(["three"]));
    const client = clientFor(list);

    await expect(
      client.listMeetingParticipants({
        accountId: "acct",
        conferenceRecordName: "conferenceRecords/1",
        limit: 0,
      })
    ).resolves.toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);

    list.mockReset();
    list
      .mockResolvedValueOnce(page(["one", "two"], "page-2"))
      .mockResolvedValueOnce(page(["three"]));
    const one = await client.listMeetingParticipants({
      accountId: "acct",
      conferenceRecordName: "conferenceRecords/1",
      limit: 1,
    });
    expect(one.map((participant) => participant.id)).toEqual(["one"]);
    expect(list).toHaveBeenCalledTimes(1);

    list.mockReset();
    list
      .mockResolvedValueOnce(page(["one", "two"], "page-2"))
      .mockResolvedValueOnce(page(["three"]));
    const all = await client.listMeetingParticipants({
      accountId: "acct",
      conferenceRecordName: "conferenceRecords/1",
    });
    expect(all.map((participant) => participant.id)).toEqual(["one", "two", "three"]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("treats a participant-session limit of 0 as an empty page and stops paging", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page(["one", "two"], "page-2"))
      .mockResolvedValueOnce(page(["three"]));
    const client = clientFor(list);

    await expect(
      client.listMeetingParticipantSessions({
        accountId: "acct",
        participantName: "participants/1",
        limit: 0,
      })
    ).resolves.toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);

    list.mockReset();
    list.mockResolvedValueOnce(page(["one", "two"]));
    const one = await client.listMeetingParticipantSessions({
      accountId: "acct",
      participantName: "participants/1",
      limit: 1,
    });
    expect(one.map((session) => session.name)).toEqual(["one"]);
  });
});
