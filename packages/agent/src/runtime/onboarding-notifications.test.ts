import type { AgentRuntime, NotificationInput } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  ONBOARDING_NOTIFICATIONS,
  seedOnboardingNotifications,
} from "./onboarding-notifications.ts";

/** Minimal runtime double: cache map + optional notification service. */
function makeRuntime(options: { withService: boolean }): {
  runtime: AgentRuntime;
  cache: Map<string, unknown>;
  notified: NotificationInput[];
} {
  const cache = new Map<string, unknown>();
  const notified: NotificationInput[] = [];
  const service = options.withService
    ? {
        notify: async (input: NotificationInput) => {
          notified.push(input);
          return { ...input, id: `id-${notified.length}` };
        },
      }
    : null;
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    getService: () => service,
  } as unknown as AgentRuntime;
  return { runtime, cache, notified };
}

describe("seedOnboardingNotifications", () => {
  it("seeds the full onboarding set once and flips the per-agent guard flag", async () => {
    const { runtime, cache, notified } = makeRuntime({ withService: true });

    await seedOnboardingNotifications(runtime);

    expect(notified).toHaveLength(ONBOARDING_NOTIFICATIONS.length);
    expect(notified.map((n) => n.groupKey)).toEqual([
      "onboarding:tutorial",
      "onboarding:help",
      "onboarding:calendar",
    ]);
    // Deep links must be plain root-relative paths (isSafeDeepLink allowlist).
    for (const n of notified) {
      expect(n.deepLink).toMatch(/^\/[a-z-]+$/);
    }
    expect(
      cache.get(
        "onboarding-notifications:seeded:00000000-0000-0000-0000-000000000001",
      ),
    ).toBe(true);
  });

  it("does NOT re-seed once the guard flag is set — a cleared inbox stays cleared", async () => {
    const { runtime, notified } = makeRuntime({ withService: true });

    await seedOnboardingNotifications(runtime);
    const afterFirst = notified.length;
    await seedOnboardingNotifications(runtime);

    expect(notified).toHaveLength(afterFirst);
  });

  it("leaves the flag unset when the NotificationService is unavailable, so a later boot still seeds", async () => {
    const headless = makeRuntime({ withService: false });

    await seedOnboardingNotifications(headless.runtime);
    expect(headless.notified).toHaveLength(0);
    expect(headless.cache.size).toBe(0);

    // Same cache, service now present (simulates the next boot with a full
    // runtime): the seed goes through.
    const cache = headless.cache;
    const notified: NotificationInput[] = [];
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: unknown) => {
        cache.set(key, value);
        return true;
      },
      getService: () => ({
        notify: async (input: NotificationInput) => {
          notified.push(input);
          return { ...input, id: `id-${notified.length}` };
        },
      }),
    } as unknown as AgentRuntime;

    await seedOnboardingNotifications(runtime);
    expect(notified).toHaveLength(ONBOARDING_NOTIFICATIONS.length);
  });
});
