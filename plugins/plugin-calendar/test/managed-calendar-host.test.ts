/**
 * Agent Calendar writes through the managed host against a synthetic Cloud that
 * echoes attendee rows the way Google does. No Cloud or Google service is called.
 */
import type { LinkedCalendarSemanticEvent } from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import {
  type CalendarSyncRequest,
  calendarAgentWrite,
  type ManagedCalendarHostApi,
} from "../src/service/managed-calendar-host.ts";

const scope = "a".repeat(64);
const source = `google:${scope}`;
const OWNER = "owner@example.com";
type Guest = { email: string; optional?: boolean };

function cloud(extra: Guest[], accountEmail: string | null = OWNER) {
  let saved: LinkedCalendarSemanticEvent | null = null;
  const client: ManagedCalendarHostApi = {
    async googleCalendarSync(command: CalendarSyncRequest) {
      if (command.kind === "capabilities")
        return {
          version: 1,
          calendarId: command.selection.calendarId,
          accountId: "google-account",
          accountEmail,
          read: true,
          write: true,
          idempotentCreate: true,
          conditionalWrites: true,
          providerExactlyOnce: false,
        };
      if (command.kind !== "create") throw Error("Unexpected command");
      saved = {
        ...structuredClone(command.event),
        attendees: [...command.event.attendees, ...extra],
      };
      return { event: { eventId: "evt-1", etag: '"v1"', event: saved } };
    },
    async googleCalendarFeed() {
      if (!saved) throw Error("Nothing written");
      return {
        syncedAt: "2026-11-01T00:00:00.000Z",
        events: [
          {
            externalId: "evt-1",
            title: saved.title,
            description: saved.description,
            location: saved.location,
            isAllDay: saved.isAllDay,
            startAt: saved.startAt,
            endAt: saved.endAt,
            metadata: { etag: '"v1"' },
            attendees: saved.attendees,
          },
        ],
      };
    },
  };
  return client;
}

const schedule = (client: ManagedCalendarHostApi, attendees: Guest[]) =>
  calendarAgentWrite(
    client,
    "owner-grant",
    scope,
    {
      operation: "write-execute",
      grantId: source,
      calendarId: "primary",
      accountId: "google-account",
      payload: {
        action: "schedule_event",
        grantId: source,
        calendarId: "primary",
        side: "owner",
        title: "Lunch",
        startsAtMs: Date.parse("2026-11-13T17:00:00.000Z"),
        endsAtMs: Date.parse("2026-11-13T18:00:00.000Z"),
        timeZone: "UTC",
        attendees,
      },
      preflight: { idempotencyKey: "stable-key" },
    },
    new AbortController().signal,
  );

describe("managed Calendar host guest verification", () => {
  it("verifies a create with guests when Google echoes the owner's own row", async () => {
    const result = await schedule(
      cloud([{ email: "Owner@Example.com", optional: false }]),
      [{ email: "bob@example.com" }],
    );
    expect(result.event.id).toBe(`${source}:evt-1`);
  });

  it("still fails when an unexpected non-owner attendee was added", async () => {
    await expect(
      schedule(cloud([{ email: "stranger@example.com" }]), [
        { email: "bob@example.com" },
      ]),
    ).rejects.toThrow("Calendar result does not match the approved change");
  });

  it("does not accept an echoed row when Cloud names no account email", async () => {
    await expect(
      schedule(cloud([{ email: OWNER }], null), [{ email: "bob@example.com" }]),
    ).rejects.toThrow("Calendar result does not match the approved change");
  });

  it("fails when a requested guest's optional flag changed", async () => {
    const dropped = cloud([]);
    const original = dropped.googleCalendarSync;
    dropped.googleCalendarSync = async (command, signal) => {
      const reply = (await original(command, signal)) as {
        event?: { event: LinkedCalendarSemanticEvent };
      };
      if (reply.event)
        reply.event.event.attendees = reply.event.event.attendees.map((a) => ({
          ...a,
          optional: true,
        }));
      return reply;
    };
    await expect(
      schedule(dropped, [{ email: "bob@example.com" }]),
    ).rejects.toThrow("Calendar result does not match the approved change");
  });
});
