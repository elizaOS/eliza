import type { IAgentRuntime } from "@elizaos/core";
import { LifeOpsService } from "../../../plugins/app-lifeops/src/lifeops/service.ts";
import { ensureLifeOpsSchema } from "./seed-grants.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function isoOffsetFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function dateFromIso(iso: string): string {
  return iso.slice(0, 10);
}

export async function seedBenchmarkLifeOpsFixtures(
  runtime: IAgentRuntime,
): Promise<void> {
  await ensureLifeOpsSchema(runtime);

  const service = new LifeOpsService(runtime);
  const david = await service.upsertRelationship({
    name: "David Park",
    primaryChannel: "email",
    primaryHandle: "david.park@example.com",
    email: "david.park@example.com",
    phone: null,
    notes: "Project contact for partnership work.",
    tags: ["work", "project"],
    relationshipType: "contact",
    lastContactedAt: isoOffsetFromNow(-9 * DAY_MS),
    metadata: { mocked: true },
  });

  await service.upsertRelationship({
    name: "Marcus Walters",
    primaryChannel: "sms",
    primaryHandle: "+15555550123",
    email: "marcus@example.com",
    phone: "+15555550123",
    notes: "Brother.",
    tags: ["family", "brother"],
    relationshipType: "family",
    lastContactedAt: isoOffsetFromNow(-14 * DAY_MS),
    metadata: { mocked: true },
  });

  await service.upsertRelationship({
    name: "Jane Patel",
    primaryChannel: "telegram",
    primaryHandle: "@janep",
    email: "jane@example.com",
    phone: null,
    notes: "Close friend and frequent collaborator.",
    tags: ["friend", "close"],
    relationshipType: "friend",
    lastContactedAt: isoOffsetFromNow(-3 * DAY_MS),
    metadata: { mocked: true },
  });

  await service.upsertRelationship({
    name: "Downtown Dental",
    primaryChannel: "twilio_voice",
    primaryHandle: "+15555550110",
    email: "appointments@downtowndental.example.com",
    phone: "+15555550110",
    notes: "Dentist office for cleanings and appointment changes.",
    tags: ["dentist", "doctor", "appointment", "medical"],
    relationshipType: "vendor",
    lastContactedAt: isoOffsetFromNow(-45 * DAY_MS),
    metadata: { mocked: true },
  });

  await service.upsertRelationship({
    name: "Comet Cable Support",
    primaryChannel: "twilio_voice",
    primaryHandle: "+15555550111",
    email: "support@cometcable.example.com",
    phone: "+15555550111",
    notes: "Cable and internet support line for outages and billing.",
    tags: ["cable", "internet", "support", "outage"],
    relationshipType: "vendor",
    lastContactedAt: isoOffsetFromNow(-30 * DAY_MS),
    metadata: { mocked: true },
  });

  await service.createFollowUp({
    relationshipId: david.id,
    dueAt: isoOffsetFromNow(7 * DAY_MS),
    reason: "Follow up about the project plan",
    priority: 2,
    draft: null,
    completedAt: null,
    metadata: { mocked: true },
  });

  const sessions = [
    {
      source: "app" as const,
      identifier: "com.apple.Safari",
      displayName: "Safari",
      startAt: isoOffsetFromNow(-90 * 60 * 1000),
      durationSeconds: 45 * 60,
    },
    {
      source: "app" as const,
      identifier: "com.microsoft.VSCode",
      displayName: "VS Code",
      startAt: isoOffsetFromNow(-3 * 60 * 60 * 1000),
      durationSeconds: 95 * 60,
    },
    {
      source: "app" as const,
      identifier: "com.tinyspeck.slackmacgap",
      displayName: "Slack",
      startAt: isoOffsetFromNow(-5 * 60 * 60 * 1000),
      durationSeconds: 20 * 60,
    },
    {
      source: "website" as const,
      identifier: "github.com",
      displayName: "github.com",
      startAt: isoOffsetFromNow(-4 * 60 * 60 * 1000),
      durationSeconds: 35 * 60,
    },
    {
      source: "website" as const,
      identifier: "calendar.google.com",
      displayName: "calendar.google.com",
      startAt: isoOffsetFromNow(-30 * 60 * 1000),
      durationSeconds: 15 * 60,
    },
    {
      source: "app" as const,
      identifier: "com.apple.Safari",
      displayName: "Safari",
      startAt: isoOffsetFromNow(-2 * DAY_MS - 3 * 60 * 60 * 1000),
      durationSeconds: 30 * 60,
    },
    {
      source: "app" as const,
      identifier: "com.microsoft.VSCode",
      displayName: "VS Code",
      startAt: isoOffsetFromNow(-3 * DAY_MS - 5 * 60 * 60 * 1000),
      durationSeconds: 80 * 60,
    },
  ];

  const dates = new Set<string>();
  for (const session of sessions) {
    const startMs = Date.parse(session.startAt);
    const endAt = new Date(
      startMs + session.durationSeconds * 1000,
    ).toISOString();
    dates.add(dateFromIso(session.startAt));
    await service.recordScreenTimeEvent({
      source: session.source,
      identifier: session.identifier,
      displayName: session.displayName,
      startAt: session.startAt,
      endAt,
      durationSeconds: session.durationSeconds,
      metadata: { mocked: true },
    });
  }

  for (const date of dates) {
    await service.aggregateDailyForDate(date);
  }
}
