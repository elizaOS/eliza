/**
 * First-run onboarding notifications — seeds the notification inbox with a few
 * getting-started pointers ("Take the tour", "Get help", "Connect your
 * calendar") exactly once per agent, so a fresh install's dashboard
 * notification center opens as a guide instead of never appearing (the widget
 * self-hides on an empty inbox).
 *
 * Seeding goes through the canonical NotificationService (persisted per-agent,
 * broadcast on the agent event bus), so the rows behave like every other
 * notification: dismissing one deletes it server-side and it never returns —
 * the once-only guard is a separate cache flag, NOT the rows themselves, so a
 * user who clears their inbox is not re-onboarded on the next boot.
 */

import type {
  AgentNotification,
  AgentRuntime,
  NotificationInput,
} from "@elizaos/core";
import { logger, ServiceType } from "@elizaos/core";

/** Structural view of NotificationService.notify — avoids a hard class import. */
interface NotifierLike {
  notify: (input: NotificationInput) => Promise<AgentNotification>;
}

function isNotifier(value: unknown): value is NotifierLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as NotifierLike).notify === "function"
  );
}

/**
 * The seed set. Deep links are plain root-relative paths so they pass the
 * client's `isSafeDeepLink` allowlist: `/tutorial` (guided tour), `/help`
 * (help center), `/connectors` (Settings → Connectors, where calendar linking
 * lives). Stable groupKeys make re-seeding idempotent even if the guard flag
 * is ever lost — a duplicate collapses onto the existing row.
 */
export const ONBOARDING_NOTIFICATIONS: readonly NotificationInput[] = [
  {
    title: "Take the tour",
    body: "New here? A two-minute guided tour shows you chat, the launcher, and your home screen.",
    category: "general",
    priority: "normal",
    source: "system",
    deepLink: "/tutorial",
    groupKey: "onboarding:tutorial",
  },
  {
    title: "Get help any time",
    body: "Stuck or curious? The help center answers common questions and can restart the tour.",
    category: "general",
    priority: "low",
    source: "system",
    deepLink: "/help",
    groupKey: "onboarding:help",
  },
  {
    title: "Connect your calendar",
    body: "Link a calendar so your agent can brief you on what's next and keep your day on track.",
    category: "general",
    priority: "low",
    source: "system",
    deepLink: "/connectors",
    groupKey: "onboarding:calendar",
  },
];

function seededFlagKey(agentId: string): string {
  return `onboarding-notifications:seeded:${agentId}`;
}

/**
 * Seed the onboarding notifications once per agent. Safe to call on every
 * boot: the per-agent cache flag short-circuits after the first successful
 * seed, and the stable groupKeys make a re-run collapse instead of stack.
 */
export async function seedOnboardingNotifications(
  runtime: AgentRuntime,
): Promise<void> {
  const flagKey = seededFlagKey(runtime.agentId);
  const alreadySeeded = await runtime.getCache<boolean>(flagKey);
  if (alreadySeeded === true) return;

  const service = runtime.getService(ServiceType.NOTIFICATION);
  if (!isNotifier(service)) {
    // No notification service on this runtime (headless/minimal boot) — leave
    // the flag unset so a later boot with the service still seeds.
    logger.debug(
      "[OnboardingNotifications] NotificationService unavailable; skipping seed",
    );
    return;
  }

  for (const input of ONBOARDING_NOTIFICATIONS) {
    await service.notify(input);
  }
  await runtime.setCache(flagKey, true);
  logger.info(
    `[OnboardingNotifications] Seeded ${ONBOARDING_NOTIFICATIONS.length} onboarding notifications`,
  );
}
