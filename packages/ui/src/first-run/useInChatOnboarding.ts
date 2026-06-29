/**
 * useInChatOnboarding — conductor for chat-centric first-run (#9952).
 *
 * When `active` (in-chat onboarding flag ON + the startup coordinator is in the
 * `first-run-required` phase), this hook seeds the greeting + runtime `[CHOICE]`
 * into the real conversation transcript, asks the floating chat to open, and
 * registers an interceptor so each first-run pick is routed into the headless
 * `first-run-use-case.ts` instead of being sent to the agent. Every returned
 * `ConductorStep` is seeded back into the transcript as a synthetic assistant
 * message (a prompt, a CHOICE marker, an OAuth secret card, or a terminal
 * "done" that triggers the tutorial-or-skip choice).
 *
 * Called once from `AppContext.tsx` with the live `setConversationMessages` and
 * a `FirstRunPorts` built from the in-scope app actions. Flag OFF
 * (`active === false`) means the hook does nothing and the legacy full-screen
 * FirstRunChat path is unchanged.
 */

import { logger } from "@elizaos/logger";
import type { Dispatch, SetStateAction } from "react";
import { useEffect } from "react";
import type { ConversationMessage } from "../api";
import { OPEN_IN_CHAT_ONBOARDING_EVENT } from "../events";
import type { FirstRunProfileDraft, FirstRunRuntime } from "./first-run";
import {
  type ChoiceSpec,
  type ConductorStep,
  chooseProvider,
  completeCloudProvisioning,
  type FirstRunPorts,
  finalizeFirstRun,
  runFirstRunRuntimeChoice,
} from "./first-run-use-case";
import {
  buildFirstRunSeedMessages,
  setFirstRunChoiceInterceptor,
} from "./in-chat-onboarding";

const STATUS_MESSAGE_ID = "first-run-status";
const TUTORIAL_CHOICE_MESSAGE_ID = "first-run-tutorial-choice";

const TUTORIAL_CHOICE: ChoiceSpec = {
  scope: "first-run",
  id: "tutorial",
  options: [
    { value: "tutorial:take", label: "Take the quick tour" },
    { value: "tutorial:skip", label: "Skip for now" },
  ],
};

function buildChoiceMarker(choice: ChoiceSpec): string {
  const header = `[CHOICE:${choice.scope} id=${choice.id}${
    choice.allowCustom ? " allow_custom" : ""
  }]`;
  const lines = choice.options.map((o) => `${o.value}=${o.label}`);
  return [header, ...lines, "[/CHOICE]"].join("\n");
}

function stepToMessage(step: ConductorStep, now: number): ConversationMessage {
  switch (step.kind) {
    case "prompt":
      return {
        id: `first-run-step-${now}`,
        role: "assistant",
        text: step.text,
        timestamp: now,
      };
    case "choice":
      return {
        id: `first-run-choice-${step.choice.id}-${now}`,
        role: "assistant",
        text: `${step.text}\n${buildChoiceMarker(step.choice)}`,
        timestamp: now,
      };
    case "secret":
      return {
        id: `first-run-secret-${now}`,
        role: "assistant",
        text: step.text,
        timestamp: now,
        secretRequest: step.secretRequest,
      };
    case "error":
      return {
        id: `first-run-error-${now}`,
        role: "assistant",
        text: step.choice
          ? `${step.text}\n${buildChoiceMarker(step.choice)}`
          : step.text,
        timestamp: now,
      };
    case "done":
      return {
        id: `first-run-done-${now}`,
        role: "assistant",
        text: step.text ?? "All set.",
        timestamp: now,
      };
  }
}

function tutorialChoiceMessage(now: number): ConversationMessage {
  return {
    id: TUTORIAL_CHOICE_MESSAGE_ID,
    role: "assistant",
    text: `Want a quick tour of the basics?\n${buildChoiceMarker(TUTORIAL_CHOICE)}`,
    timestamp: now,
  };
}

/** Infer the draft runtime from a pick value so a continued flow stays coherent. */
function runtimeForValue(value: string): FirstRunRuntime {
  if (value === "cloud" || value.startsWith("agent:")) return "cloud";
  if (value === "local" || value.startsWith("provider:")) return "local";
  return "local";
}

export function useInChatOnboarding(
  active: boolean,
  setConversationMessages: Dispatch<SetStateAction<ConversationMessage[]>>,
  ports: FirstRunPorts,
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

    const appendStep = (step: ConductorStep): void => {
      setConversationMessages((prev) => {
        // A terminal step clears any lingering status indicator.
        const base = prev.filter((m) => m.id !== STATUS_MESSAGE_ID);
        const next = [...base, stepToMessage(step, Date.now())];
        if (step.kind === "done")
          next.push(tutorialChoiceMessage(Date.now() + 1));
        return next;
      });
    };

    const onProgress = (text: string | null): void => {
      setConversationMessages((prev) => {
        const base = prev.filter((m) => m.id !== STATUS_MESSAGE_ID);
        if (text === null) return base;
        return [
          ...base,
          {
            id: STATUS_MESSAGE_ID,
            role: "assistant",
            text,
            timestamp: Date.now(),
          },
        ];
      });
    };

    const livePorts: FirstRunPorts = { ...ports, onProgress };

    const route = async (value: string): Promise<void> => {
      const draft: FirstRunProfileDraft = {
        agentName: "Eliza",
        runtime: runtimeForValue(value),
        localInference: "all-local",
        remoteApiBase: "",
        remoteToken: "",
      };

      if (value === "tutorial:take" || value === "tutorial:skip") {
        finalizeFirstRun(livePorts, value === "tutorial:take");
        setConversationMessages((prev) =>
          prev.filter((m) => m.id !== TUTORIAL_CHOICE_MESSAGE_ID),
        );
        return;
      }
      if (value === "cloud" || value === "local" || value === "other") {
        appendStep(await runFirstRunRuntimeChoice(livePorts, value, draft));
        return;
      }
      if (value === "provider:on-device" || value === "provider:elizacloud") {
        const providerId =
          value === "provider:elizacloud" ? "elizacloud" : "on-device";
        appendStep(await chooseProvider(livePorts, draft, providerId));
        return;
      }
      if (value.startsWith("agent:")) {
        const agentId = value.slice("agent:".length);
        appendStep(
          await completeCloudProvisioning(
            livePorts,
            draft,
            agentId === "new"
              ? { forceCreate: true }
              : { preferAgentId: agentId },
          ),
        );
      }
    };

    setFirstRunChoiceInterceptor((value: string) => {
      void route(value).catch((error: unknown) => {
        logger.error(
          `[InChatOnboarding] choice routing failed: ${String(error)}`,
        );
        onProgress(null);
        appendStep({
          kind: "error",
          text: "Something went wrong setting that up. Want to try again?",
          choice: {
            scope: "first-run",
            id: "runtime",
            allowCustom: true,
            options: [
              { value: "cloud", label: "Log in with Eliza Cloud" },
              { value: "local", label: "Run locally on this device" },
              { value: "other", label: "Something else…" },
            ],
          },
        });
      });
    });

    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(OPEN_IN_CHAT_ONBOARDING_EVENT));
    }

    return () => setFirstRunChoiceInterceptor(null);
  }, [active, setConversationMessages, ports]);
}
