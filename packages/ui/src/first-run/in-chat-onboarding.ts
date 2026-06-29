/**
 * In-chat onboarding (#9952) — chat-centric first-run.
 *
 * When the `inChatOnboarding` boot-config flag is ON, a fresh profile lands
 * directly on the homescreen with the real floating chat (ContinuousChatOverlay)
 * auto-opened, and the onboarding greeting + a runtime CHOICE widget are seeded
 * into that real chat as synthetic assistant messages. The choice renders for
 * free via the existing `InlineWidgetText` marker path — no separate surface.
 *
 * This module owns the flag read, the seed-message construction, and the
 * first-run choice interceptor registry. The provisioning logic lives in the
 * headless `first-run-use-case.ts`; the conductor (`useInChatOnboarding`)
 * registers a handler here that routes each pick into that use case.
 *
 * Choice grammar: every first-run pick encodes its scope id into the choice
 * `value` (`provider:on-device`, `agent:new`, `tutorial:take`, …) so the
 * existing value-only `sendAction(value)` round-trips it without threading the
 * `ChoiceMatch.id` through `InlineWidgetText`. The bare runtime values
 * (`cloud` / `local` / `other`) keep their short form.
 */

import { logger } from "@elizaos/logger";
import type { ConversationMessage } from "../api";
import { getBootConfig } from "../config/boot-config-store";

/** Scope tag carried by every onboarding `[CHOICE:first-run …]` marker. */
export const FIRST_RUN_CHOICE_SCOPE = "first-run";

/** The runtime-selection choice values seeded first. */
export const FIRST_RUN_RUNTIME_VALUES = ["cloud", "local", "other"] as const;
export type FirstRunRuntimeValue = (typeof FIRST_RUN_RUNTIME_VALUES)[number];

/** Scoped value prefixes for the later choice steps (provider / agent / tutorial). */
const FIRST_RUN_SCOPED_PREFIXES = ["provider:", "agent:", "tutorial:"] as const;

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

function isFirstRunRuntimeValue(value: string): value is FirstRunRuntimeValue {
  return (FIRST_RUN_RUNTIME_VALUES as readonly string[]).includes(value);
}

/** True for any value the in-chat onboarding interceptor owns. */
export function isFirstRunChoiceValue(value: string): boolean {
  if (isFirstRunRuntimeValue(value)) return true;
  return FIRST_RUN_SCOPED_PREFIXES.some((prefix) => value.startsWith(prefix));
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

// ---------------------------------------------------------------------------
// First-run choice interceptor registry
//
// `sendActionMessage` (useChatSend) consults this before sending a choice pick
// to the agent. Only the in-chat onboarding conductor registers a handler, so
// when onboarding is inactive `consumeFirstRunChoice` is a no-op and the normal
// send path is byte-identical.
// ---------------------------------------------------------------------------

export type FirstRunChoiceHandler = (value: string) => void;

let activeFirstRunChoiceHandler: FirstRunChoiceHandler | null = null;

/** Register (or clear, with `null`) the active first-run choice handler. */
export function setFirstRunChoiceInterceptor(
  handler: FirstRunChoiceHandler | null,
): void {
  activeFirstRunChoiceHandler = handler;
}

/**
 * Intercept a chat-send value while in-chat onboarding is active. Returns true
 * (and routes to the registered handler) when `value` is a first-run choice;
 * false otherwise, so the caller proceeds with a normal send.
 */
export function consumeFirstRunChoice(value: string): boolean {
  const handler = activeFirstRunChoiceHandler;
  if (!handler) return false;
  if (!isFirstRunChoiceValue(value)) return false;
  logger.info(`[InChatOnboarding] intercepted first-run choice: ${value}`);
  handler(value);
  return true;
}
