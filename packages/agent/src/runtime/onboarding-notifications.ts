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
 * The seed set. Deep links are root-relative paths so they pass the client's
 * `isSafeDeepLink` allowlist. All three live in the conversation: `/chat`
 * opens the floating chat, and `/chat?prefill=<text>` additionally seeds the
 * composer with a ready-to-send ask (never auto-sent), so tapping a row lands
 * the user IN the flow — the tour row with the tour ask, the calendar row with
 * a connect-my-calendar ask the agent answers with its connector flow — rather
 * than dumping them on a settings page. Stable groupKeys make re-seeding
 * idempotent even if the guard flag is ever lost — a duplicate collapses onto
 * the existing row.
 */
export const ONBOARDING_NOTIFICATIONS: readonly NotificationInput[] = [
  {
    title: "Take the tour",
    body: "New here? A one-minute tour runs right in the chat — walk through messaging, voice, and navigating by asking.",
    category: "general",
    priority: "normal",
    source: "system",
    deepLink: "/chat?prefill=Take%20a%20quick%20tour",
    groupKey: "onboarding:tutorial",
  },
  {
    title: "Get help any time",
    body: "Stuck or curious? Just ask in the chat — your agent answers questions about the app and can restart the tour.",
    category: "general",
    priority: "low",
    source: "system",
    deepLink: "/chat",
    groupKey: "onboarding:help",
  },
  {
    title: "Connect your calendar",
    body: "Link a calendar so your agent can brief you on what's next and keep your day on track.",
    category: "general",
    priority: "low",
    source: "system",
    deepLink:
      "/chat?prefill=Connect%20my%20calendar%20so%20you%20can%20brief%20me%20on%20my%20day",
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
