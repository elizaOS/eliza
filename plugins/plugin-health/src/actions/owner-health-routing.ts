/**
 * Routes explicit owner telemetry reads into the health action surface before
 * a general-purpose model can misclassify them as static wellness advice.
 */
import type {
  ResponseHandlerEvaluator,
  ResponseHandlerEvaluatorContext,
} from "@elizaos/core";

const OWNER_HEALTH_ACTION = "OWNER_HEALTH";
const OWNER_REFERENCE = /\b(?:i|my|mine)\b/i;
const HEALTH_SIGNAL =
  /\b(?:sleep|slept|recovery|recover(?:ed|y)?|resting heart rate|heart rate|hrv|steps?|active minutes?|activity|workouts?|calories?|distance|fitness|wearable|biometric)\b/i;
const READ_INTENT =
  /\b(?:check|show|review|summarize|tell me|status|trend|how (?:did|has|is|was)|what (?:did|is|was|were))\b/i;
const GENERAL_GUIDANCE =
  /\b(?:advice|tips?|improv(?:e|ing)|what should i|how (?:can|should|do) i|help me)\b/i;
const CLINICAL_ADVICE =
  /\b(?:diagnos|treat|medicat|dosage|symptom|pain|injur|doctor|emergency)\b/i;

function hasOwnerHealthAction(
  context: ResponseHandlerEvaluatorContext,
): boolean {
  return context.runtime.actions.some(
    (action) => action.name === OWNER_HEALTH_ACTION,
  );
}

export function isOwnerHealthReadRequest(text: string): boolean {
  return (
    OWNER_REFERENCE.test(text) &&
    HEALTH_SIGNAL.test(text) &&
    READ_INTENT.test(text) &&
    !GENERAL_GUIDANCE.test(text) &&
    !CLINICAL_ADVICE.test(text)
  );
}

function shouldRoute(context: ResponseHandlerEvaluatorContext): boolean {
  if (context.messageHandler.processMessage === "STOP") return false;
  const text = context.message.content.text;
  return (
    typeof text === "string" &&
    isOwnerHealthReadRequest(text) &&
    hasOwnerHealthAction(context)
  );
}

export const ownerHealthRoutingEvaluator: ResponseHandlerEvaluator = {
  name: "health.owner-telemetry-routing",
  description:
    "Routes explicit first-person sleep, recovery, activity, and wearable reads to OWNER_HEALTH while leaving clinical advice on the safety path.",
  priority: 15,
  shouldRun: shouldRoute,
  evaluate: (context) => {
    if (!shouldRoute(context)) return undefined;
    return {
      requiresTool: true,
      setContexts: ["health"],
      clearCandidateActions: true,
      addCandidateActions: [OWNER_HEALTH_ACTION],
      clearParentActionHints: true,
      addParentActionHints: [OWNER_HEALTH_ACTION],
      clearReply: true,
      debug: [
        "explicit owner telemetry read; routing to OWNER_HEALTH instead of static wellness advice",
      ],
    };
  },
};
