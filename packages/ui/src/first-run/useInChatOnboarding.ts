/**
 * useInChatOnboarding — Phase 1 conductor for chat-centric first-run.
 *
 * When `active` (in-chat onboarding flag ON + the startup coordinator is in the
 * `first-run-required` phase), this hook seeds the greeting + runtime `[CHOICE]`
 * into the real conversation transcript, asks the floating chat to open, and
 * registers an interceptor so a first-run choice pick appends a local
 * acknowledgement instead of being sent to the agent.
 *
 * Kept out of App.tsx on purpose — App.tsx calls this once with the live
 * `setConversationMessages`. Flag OFF (`active === false`) means the hook does
 * nothing and the legacy full-screen FirstRunChat path is unchanged.
 */

import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ConversationMessage } from "../api";
import { OPEN_IN_CHAT_ONBOARDING_EVENT } from "../events";
import {
  buildFirstRunAckMessage,
  buildFirstRunSeedMessages,
  type FirstRunRuntimeValue,
  setFirstRunChoiceInterceptor,
} from "./in-chat-onboarding";

export function useInChatOnboarding(
  active: boolean,
  setConversationMessages: Dispatch<SetStateAction<ConversationMessage[]>>,
): void {
  useEffect(() => {
    if (!active) return undefined;

    const seedIds = new Set(
      buildFirstRunSeedMessages(0).map((message) => message.id),
    );
    setConversationMessages((prev) => {
      // Idempotent: never double-seed if the effect re-runs.
      if (prev.some((message) => seedIds.has(message.id))) return prev;
      return [...prev, ...buildFirstRunSeedMessages(Date.now())];
    });

    setFirstRunChoiceInterceptor((value: FirstRunRuntimeValue) => {
      // Phase 1: demonstrate the wiring with a local acknowledgement.
      // SEAM (Phase 2): route `value` to the headless first-run use case
      // (finishLocal / finishCloud / settings handoff) and persist once.
      setConversationMessages((prev) => [
        ...prev,
        buildFirstRunAckMessage(value, Date.now()),
      ]);
    });

    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(OPEN_IN_CHAT_ONBOARDING_EVENT));
    }

    return () => setFirstRunChoiceInterceptor(null);
  }, [active, setConversationMessages]);
}
