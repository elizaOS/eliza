/**
 * First-run home notifications — seeds a small, deliberate mix of priority and
 * quieter getting-started pointers exactly once per agent. Fresh installs open
 * with useful interrupt-tier cards already visible, while the quieter rows
 * exercise the explicit "More" expansion without overwhelming the dashboard.
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
 * Deep links are root-relative paths so they pass the client's safe-link
 * allowlist. Distinct sources form useful producer stacks instead of one giant
 * synthetic "system" stack. The Getting Started producer intentionally mixes
 * a high and a normal row so the rested card has a real quieter sibling to fan.
 * Stable groupKeys make re-seeding idempotent if the guard flag is ever lost.
 */
export const DEFAULT_HOME_NOTIFICATIONS: readonly NotificationInput[] = [
  {
    title: "Take the tour",
    body: "New here? A one-minute tour runs right in the chat — walk through messaging, voice, and navigating by asking.",
    category: "general",
    priority: "high",
    source: "getting-started",
    deepLink: "/chat?prefill=Take%20a%20quick%20tour",
    groupKey: "onboarding:tutorial",
  },
  {
    title: "Choose your AI model",
    body: "Connect a Claude or Codex subscription so your agent is ready to work.",
    category: "approval",
    priority: "high",
    source: "setup",
    deepLink: "/settings#ai-model",
    groupKey: "onboarding:ai-model",
  },
  {
    title: "Connect your calendar",
    body: "Link a calendar so your agent can brief you on what's next and keep your day on track.",
    category: "general",
    priority: "normal",
    source: "calendar",
    deepLink:
      "/chat?prefill=Connect%20my%20calendar%20so%20you%20can%20brief%20me%20on%20my%20day",
    groupKey: "onboarding:calendar",
  },
  {
    title: "Get help any time",
    body: "Stuck or curious? Ask in chat — your agent can answer questions about Eliza or restart the tour.",
    category: "general",
    priority: "normal",
    source: "getting-started",
    deepLink: "/chat",
    groupKey: "onboarding:help",
  },
];

/** Compatibility name retained for callers and tests that describe first boot. */
export const ONBOARDING_NOTIFICATIONS = DEFAULT_HOME_NOTIFICATIONS;

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
