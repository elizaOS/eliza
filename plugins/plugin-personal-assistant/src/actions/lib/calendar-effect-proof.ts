/**
 * Converts one calendar feed into stable receipt proof without inventing
 * provider identity or observation time. Calendar actions carry this proof
 * through their result so the outer settlement boundary never re-reads a
 * newer snapshot than the one used to answer the owner.
 */

import { createHash } from "node:crypto";
import {
  type EffectResourceRef,
  ElizaError,
  stableStringify,
} from "@elizaos/core";
import type { LifeOpsCalendarFeed } from "@elizaos/shared";

export interface CalendarSnapshotEffectProof {
  readonly resource: EffectResourceRef;
  readonly artifacts: readonly EffectResourceRef[];
  readonly observedAt: string;
}

function validTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function snapshotVersion(feed: LifeOpsCalendarFeed): string {
  return createHash("sha256")
    .update(
      stableStringify({
        calendarId: feed.calendarId,
        source: feed.source,
        state: feed.state,
        timeMin: feed.timeMin,
        timeMax: feed.timeMax,
        syncedAt: feed.syncedAt,
        sources: feed.sources.map((source) => ({
          key: source.key,
          status: source.status,
          syncedAt: source.syncedAt,
          error: source.error,
        })),
        events: feed.events.map((event) => ({
          id: event.id,
          externalId: event.externalId,
          provider: event.provider,
          side: event.side,
          grantId: event.grantId ?? null,
          calendarId: event.calendarId,
          startAt: event.startAt,
          endAt: event.endAt,
          syncedAt: event.syncedAt,
          updatedAt: event.updatedAt,
        })),
      }),
    )
    .digest("hex");
}

export function calendarSnapshotEffectProof(
  feed: LifeOpsCalendarFeed,
): CalendarSnapshotEffectProof {
  const observedAtMs = [
    validTimestamp(feed.syncedAt),
    ...feed.sources.map((source) => validTimestamp(source.syncedAt)),
    ...feed.events.flatMap((event) => [
      validTimestamp(event.syncedAt),
      validTimestamp(event.updatedAt),
    ]),
  ].reduce<number | null>(
    (latest, candidate) =>
      candidate !== null && (latest === null || candidate > latest)
        ? candidate
        : latest,
    null,
  );
  if (observedAtMs === null) {
    throw new ElizaError(
      "Calendar feed is missing authoritative snapshot time",
      {
        code: "CALENDAR_EFFECT_SNAPSHOT_TIME_REQUIRED",
        context: {
          calendarId: feed.calendarId,
          state: feed.state,
          sourceCount: feed.sources.length,
          eventCount: feed.events.length,
        },
        severity: "fatal",
      },
    );
  }

  const artifacts = Array.from(
    new Map(
      feed.events.map((event) => [
        event.id,
        {
          kind: "calendar.event",
          id: event.id,
          version: event.updatedAt,
        } satisfies EffectResourceRef,
      ]),
    ).values(),
  );
  return {
    resource: {
      kind: "calendar.feed",
      id: feed.calendarId,
      version: snapshotVersion(feed),
    },
    artifacts,
    observedAt: new Date(observedAtMs).toISOString(),
  };
}

export function readCalendarSnapshotEffectProof(
  value: unknown,
): CalendarSnapshotEffectProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const resource = record.resource;
  const artifacts = record.artifacts;
  const observedAt = record.observedAt;
  if (
    !resource ||
    typeof resource !== "object" ||
    Array.isArray(resource) ||
    !Array.isArray(artifacts) ||
    typeof observedAt !== "string" ||
    !Number.isFinite(Date.parse(observedAt))
  ) {
    return null;
  }
  const resourceRecord = resource as Record<string, unknown>;
  if (
    resourceRecord.kind !== "calendar.feed" ||
    typeof resourceRecord.id !== "string" ||
    !resourceRecord.id.trim() ||
    typeof resourceRecord.version !== "string" ||
    !resourceRecord.version.trim()
  ) {
    return null;
  }
  const parsedArtifacts: EffectResourceRef[] = [];
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      return null;
    }
    const artifactRecord = artifact as Record<string, unknown>;
    if (
      artifactRecord.kind !== "calendar.event" ||
      typeof artifactRecord.id !== "string" ||
      !artifactRecord.id.trim() ||
      typeof artifactRecord.version !== "string" ||
      !artifactRecord.version.trim()
    ) {
      return null;
    }
    parsedArtifacts.push({
      kind: "calendar.event",
      id: artifactRecord.id,
      version: artifactRecord.version,
    });
  }
  return {
    resource: {
      kind: "calendar.feed",
      id: resourceRecord.id,
      version: resourceRecord.version,
    },
    artifacts: parsedArtifacts,
    observedAt,
  };
}
