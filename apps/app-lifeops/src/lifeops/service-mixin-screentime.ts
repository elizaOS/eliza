// @ts-nocheck — mixin: type safety is enforced on the composed class
import crypto from "node:crypto";
import type {
  LifeOpsScreenTimeDaily,
  LifeOpsScreenTimeSession,
} from "@elizaos/shared/contracts/lifeops";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";

function isoNow(): string {
  return new Date().toISOString();
}

function computeDurationSeconds(
  startAt: string,
  endAt: string | null | undefined,
  provided: number | undefined,
): number {
  if (typeof provided === "number" && Number.isFinite(provided) && provided >= 0) {
    return Math.floor(provided);
  }
  if (!endAt) return 0;
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  const delta = Math.max(0, Math.floor((endMs - startMs) / 1000));
  return delta;
}

function localDateOf(iso: string): string {
  // YYYY-MM-DD extracted from ISO string directly (UTC component).
  // Repository aggregation uses the same slice, so they stay consistent.
  return iso.slice(0, 10);
}

/** @internal */
export function withScreenTime<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsScreenTimeServiceMixin extends Base {
    async recordScreenTimeEvent(event: {
      source: "app" | "website";
      identifier: string;
      displayName: string;
      startAt: string;
      endAt?: string | null;
      durationSeconds?: number;
      metadata?: Record<string, unknown>;
    }): Promise<LifeOpsScreenTimeSession> {
      if (event.source !== "app" && event.source !== "website") {
        fail(400, "source must be 'app' or 'website'");
      }
      if (!event.identifier || typeof event.identifier !== "string") {
        fail(400, "identifier is required");
      }
      if (!event.startAt || typeof event.startAt !== "string") {
        fail(400, "startAt is required");
      }
      const now = isoNow();
      const endAt = event.endAt ?? null;
      const isActive = endAt === null;
      const durationSeconds = computeDurationSeconds(
        event.startAt,
        endAt,
        event.durationSeconds,
      );
      const session: LifeOpsScreenTimeSession = {
        id: crypto.randomUUID(),
        agentId: this.agentId(),
        source: event.source,
        identifier: event.identifier,
        displayName: event.displayName || event.identifier,
        startAt: event.startAt,
        endAt,
        durationSeconds,
        isActive,
        metadata: event.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.upsertScreenTimeSession(session);
      return session;
    }

    async finishActiveScreenTimeSession(
      id: string,
      endAt: string,
      durationSeconds: number,
    ): Promise<void> {
      await this.repository.finishScreenTimeSession(
        this.agentId(),
        id,
        endAt,
        Math.max(0, Math.floor(durationSeconds)),
      );
    }

    async getScreenTimeDaily(opts: {
      date: string;
      source?: "app" | "website";
      limit?: number;
    }): Promise<LifeOpsScreenTimeDaily[]> {
      return this.repository.listScreenTimeDaily(this.agentId(), opts.date, {
        source: opts.source,
        limit: opts.limit,
      });
    }

    async getScreenTimeSummary(opts: {
      since: string;
      until: string;
      source?: "app" | "website";
      topN?: number;
    }): Promise<{
      items: Array<{
        source: "app" | "website";
        identifier: string;
        displayName: string;
        totalSeconds: number;
      }>;
      totalSeconds: number;
    }> {
      const sessions = await this.repository.listScreenTimeSessionsBetween(
        this.agentId(),
        opts.since,
        opts.until,
        { source: opts.source },
      );
      const groups = new Map<
        string,
        {
          source: "app" | "website";
          identifier: string;
          displayName: string;
          totalSeconds: number;
        }
      >();
      let totalSeconds = 0;
      for (const s of sessions) {
        const key = `${s.source}::${s.identifier}`;
        const current = groups.get(key);
        if (current) {
          current.totalSeconds += s.durationSeconds;
        } else {
          groups.set(key, {
            source: s.source,
            identifier: s.identifier,
            displayName: s.displayName,
            totalSeconds: s.durationSeconds,
          });
        }
        totalSeconds += s.durationSeconds;
      }
      const items = [...groups.values()].sort(
        (a, b) => b.totalSeconds - a.totalSeconds,
      );
      const topN = opts.topN ?? items.length;
      return { items: items.slice(0, topN), totalSeconds };
    }

    async aggregateDailyForDate(date: string): Promise<{ updated: number }> {
      return this.repository.aggregateScreenTimeDailyForDate(
        this.agentId(),
        date,
      );
    }
  }
  return LifeOpsScreenTimeServiceMixin;
}
