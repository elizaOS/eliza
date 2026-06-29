/**
 * In-chat onboarding (Phase 1) — chat-centric first-run.
 *
 * When the `inChatOnboarding` boot-config flag is ON, a fresh profile lands
 * directly on the homescreen with the real floating chat (ContinuousChatOverlay)
 * auto-opened, and the onboarding greeting + a runtime CHOICE widget are seeded
 * into that real chat as synthetic assistant messages. The choice renders for
 * free via the existing `InlineWidgetText` marker path — no separate surface.
 *
 * This module owns ONLY the flag read, the seed-message construction, and a
 * tiny interceptor registry so a first-run choice pick is handled locally
 * instead of being sent to the agent. The headless first-run use case
 * (provisioning) is wired in Phase 2 — see the SEAM marker in
 * `consumeFirstRunChoice`.
 */

import { logger } from "@elizaos/logger";
import type { ConversationMessage } from "../api";
import { getBootConfig } from "../config/boot-config-store";

/** Scope tag carried by the onboarding `[CHOICE:first-run …]` marker. */
export const FIRST_RUN_CHOICE_SCOPE = "first-run";

/** The runtime-selection choice values seeded at first-run. */
export const FIRST_RUN_RUNTIME_VALUES = ["cloud", "local", "other"] as const;
export type FirstRunRuntimeValue = (typeof FIRST_RUN_RUNTIME_VALUES)[number];

/** localStorage override the e2e harness sets to flip the flag on without a host build. */
const LOCAL_STORAGE_FLAG_KEY = "eliza:in-chat-onboarding";

/**
 * True when the chat-centric first-run experience is enabled. Reads the
 * `inChatOnboarding` boot-config flag (host-provided) OR a localStorage
 * override (so the e2e harness can enable it on a stock build). Defaults to
 * false — flag OFF is byte-identical to the legacy full-screen FirstRunChat.
 */
export function isInChatOnboardingEnabled(): boolean {
  if (getBootConfig().inChatOnboarding === true) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LOCAL_STORAGE_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

const GREETING_MESSAGE_ID = "first-run-greeting";
const RUNTIME_CHOICE_MESSAGE_ID = "first-run-runtime-choice";

const GREETING_TEXT =
  "hey there! I'm Eliza — your local-first AI assistant. Let's get you set up. " +
  "How would you like to run me?";

const RUNTIME_CHOICE_MARKER = [
  `[CHOICE:${FIRST_RUN_CHOICE_SCOPE} id=runtime allow_custom]`,
  "cloud=Log in with Eliza Cloud",
  "local=Run locally on this device",
  "other=Something else…",
  "[/CHOICE]",
].join("\n");

/** Labels keyed by runtime value, for the local acknowledgement message. */
const RUNTIME_VALUE_LABELS: Record<FirstRunRuntimeValue, string> = {
  cloud: "Eliza Cloud",
  local: "a local agent on this device",
  other: "a custom setup",
};

function isFirstRunRuntimeValue(value: string): value is FirstRunRuntimeValue {
  return (FIRST_RUN_RUNTIME_VALUES as readonly string[]).includes(value);
}

/**
 * The two synthetic assistant messages seeded into the live transcript: the
 * greeting, then the runtime `[CHOICE]` block (rendered as buttons by
 * `InlineWidgetText`). `now` is injected so callers stay deterministic.
 */
export function buildFirstRunSeedMessages(now: number): ConversationMessage[] {
  return [
    {
      id: GREETING_MESSAGE_ID,
      role: "assistant",
      text: GREETING_TEXT,
      timestamp: now,
    },
    {
      id: RUNTIME_CHOICE_MESSAGE_ID,
      role: "assistant",
      text: RUNTIME_CHOICE_MARKER,
      timestamp: now + 1,
    },
  ];
}

/** The local acknowledgement appended when a first-run runtime choice is picked. */
export function buildFirstRunAckMessage(
  value: FirstRunRuntimeValue,
  now: number,
): ConversationMessage {
  return {
    id: `first-run-ack-${value}`,
    role: "assistant",
    text: `Great — setting up ${RUNTIME_VALUE_LABELS[value]}…`,
    timestamp: now,
  };
}

// ---------------------------------------------------------------------------
// First-run choice interceptor registry
//
// `sendActionMessage` (useChatSend) consults this before sending a choice pick
// to the agent. Only the in-chat onboarding conductor registers a handler, so
// when onboarding is inactive `consumeFirstRunChoice` is a no-op and the normal
// send path is byte-identical.
// ---------------------------------------------------------------------------

type FirstRunChoiceHandler = (value: FirstRunRuntimeValue) => void;

let activeFirstRunChoiceHandler: FirstRunChoiceHandler | null = null;

/** Register (or clear, with `null`) the active first-run choice handler. */
export function setFirstRunChoiceInterceptor(
  handler: FirstRunChoiceHandler | null,
): void {
  activeFirstRunChoiceHandler = handler;
}

/**
 * Intercept a chat-send value while in-chat onboarding is active. Returns true
 * (and routes to the registered handler) when `value` is a first-run runtime
 * choice; false otherwise, so the caller proceeds with a normal send.
 */
export function consumeFirstRunChoice(value: string): boolean {
  const handler = activeFirstRunChoiceHandler;
  if (!handler) return false;
  if (!isFirstRunRuntimeValue(value)) return false;
  logger.info(`[InChatOnboarding] intercepted first-run runtime choice: ${value}`);
  handler(value);
  return true;
}
