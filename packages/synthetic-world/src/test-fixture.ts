/**
 * Supplies one realistic, entirely synthetic manifest for package contract
 * tests without weakening production fixture validation.
 */
import {
  SYNTHETIC_WORLD_SCHEMA_VERSION,
  type WorldManifest,
} from "./manifest.ts";

export function testManifest(): WorldManifest {
  return {
    schemaVersion: SYNTHETIC_WORLD_SCHEMA_VERSION,
    worldId: "mail-reminder",
    seed: "mail-reminder-v1",
    clock: {
      epoch: "2030-01-01T08:00:00.000Z",
      timezone: "America/Los_Angeles",
    },
    fixturePolicy: {
      allowedEmailDomains: ["example.com", "example.invalid"],
      allowedUrlHosts: [
        "example.com",
        "example.invalid",
        "localhost",
        "127.0.0.1",
      ],
    },
    data: {
      identities: [
        {
          id: "person-owner",
          kind: "person",
          displayName: "Avery Example",
          email: "avery@example.com",
          phone: "+1-555-0100",
        },
        {
          id: "person-peer",
          kind: "person",
          displayName: "Morgan Example",
          email: "morgan@example.invalid",
        },
      ],
      organizations: [
        {
          id: "org-example",
          name: "Example Org",
          memberIdentityIds: ["person-owner", "person-peer"],
        },
      ],
      agents: [
        {
          id: "agent-helper",
          name: "Helper",
          ownerIdentityId: "person-owner",
          organizationId: "org-example",
        },
      ],
      rooms: [
        {
          id: "room-direct",
          kind: "direct",
          participantIdentityIds: ["person-owner", "person-peer"],
        },
      ],
      threads: [
        {
          id: "thread-reminder",
          roomId: "room-direct",
          title: "Reminder request",
          participantIdentityIds: ["person-owner", "person-peer"],
        },
      ],
      messages: [
        {
          id: "message-one",
          roomId: "room-direct",
          senderIdentityId: "person-peer",
          body: "Please remind me tomorrow.",
          sentAt: "2030-01-01T08:00:00.000Z",
          threadId: "thread-reminder",
        },
      ],
      connectorAccounts: [],
      grants: [],
      calendars: [
        {
          id: "calendar-main",
          ownerIdentityId: "person-owner",
          name: "Main",
          timezone: "America/Los_Angeles",
        },
      ],
      calendarEvents: [
        {
          id: "event-one",
          calendarId: "calendar-main",
          title: "Planning",
          startsAt: "2030-01-02T18:00:00.000Z",
          endsAt: "2030-01-02T19:00:00.000Z",
          attendeeIdentityIds: ["person-owner", "person-peer"],
        },
      ],
      tasks: [
        {
          id: "task-one",
          ownerIdentityId: "person-owner",
          title: "Reply",
          status: "pending",
          dueAt: "2030-01-02T08:00:00.000Z",
        },
      ],
      reminders: [
        {
          id: "reminder-one",
          taskId: "task-one",
          ownerIdentityId: "person-owner",
          message: "Reply",
          fireAt: "2030-01-02T08:00:00.000Z",
          status: "scheduled",
        },
      ],
      contacts: [
        {
          id: "contact-peer",
          ownerIdentityId: "person-owner",
          identityId: "person-peer",
          tags: ["work"],
        },
      ],
      relationships: [
        {
          id: "relationship-peer",
          fromIdentityId: "person-owner",
          toIdentityId: "person-peer",
          kind: "colleague",
        },
      ],
      memories: [
        {
          id: "memory-one",
          agentId: "agent-helper",
          ownerIdentityId: "person-owner",
          roomId: "room-direct",
          content: { text: "Morgan prefers mornings" },
          createdAt: "2030-01-01T08:00:00.000Z",
        },
      ],
      approvals: [
        {
          id: "approval-one",
          requesterIdentityId: "person-owner",
          approverIdentityId: "person-peer",
          action: "send-payment",
          status: "pending",
          requestedAt: "2030-01-01T08:00:00.000Z",
        },
      ],
      outbox: [
        {
          id: "outbox-one",
          target: "mail.send",
          payload: { messageId: "message-one" },
          status: "pending",
          idempotencyKey: "synthetic-outbox-one",
          attempts: 0,
          availableAt: "2030-01-01T08:00:00.000Z",
        },
      ],
      notifications: [
        {
          id: "notification-one",
          recipientIdentityId: "person-owner",
          channel: "push",
          body: "Reply due",
          status: "queued",
          deliverAt: "2030-01-02T08:00:00.000Z",
        },
      ],
      media: [
        {
          id: "media-one",
          sha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          mimeType: "text/plain",
          byteLength: 7,
          url: "https://example.invalid/media/one",
        },
      ],
      billingAccounts: [
        {
          id: "billing-one",
          ownerIdentityId: "person-owner",
          currency: "USD",
          balanceMinor: 5000,
        },
      ],
      billingTransactions: [
        {
          id: "transaction-one",
          accountId: "billing-one",
          amountMinor: -100,
          currency: "USD",
          kind: "purchase",
          occurredAt: "2030-01-01T08:00:00.000Z",
        },
      ],
      providerState: [
        {
          id: "provider-mail",
          provider: "mail",
          state: { cursor: "synthetic-cursor" },
        },
      ],
      backgroundJobs: [
        {
          id: "job-one",
          queue: "notifications",
          kind: "deliver",
          status: "queued",
          runAt: "2030-01-02T08:00:00.000Z",
          attempts: 0,
          payload: { notificationId: "notification-one" },
        },
      ],
      extensions: {},
    },
    faults: [],
  };
}
