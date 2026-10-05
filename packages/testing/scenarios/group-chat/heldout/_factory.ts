/**
 * Builds transcript, room, and turn setup for held-out intervention scenarios.
 * The manifest shares one acceptance contract per timing label.
 */
import type {
  ScenarioDefinition,
  ScenarioSeedStep,
  ScenarioTurn,
} from "@elizaos/testing";
import { scenario } from "@elizaos/testing";

type MessageTurn = ScenarioTurn;
type HeldoutSetup = Pick<
  ScenarioDefinition,
  "tags" | "description" | "isolation" | "rooms" | "seed"
> & { decisionTurn: MessageTurn };

export type HeldoutTurn = { speaker: string; text: string };

export type HeldoutScenarioConfig = {
  lane?: "live-only";
  id: string;
  title: string;
  label: "speak" | "silent";
  directlyAddressed: boolean;
  targetSpeaker: string;
  context: HeldoutTurn[];
  decisionTurn: HeldoutTurn;
  sourceDomain: "ami" | "friends" | "spgi";
  sourceDecisionPointId: string;
  sourceRevision: string;
};

const NOW = new Date("2026-08-23T12:00:00.000Z");
export function buildHeldoutSetup(config: HeldoutScenarioConfig) {
  const seed: ScenarioSeedStep[] = config.context.map((turn, index) => ({
    type: "memory",
    name: `context-${index}`,
    content: {
      kind: "inbound-message",
      platform: "scenario",
      displayName: turn.speaker,
      handle: turn.speaker,
      text: turn.text,
      occurredAt: new Date(
        NOW.getTime() - (config.context.length - index + 1) * 60_000,
      ).toISOString(),
      messageId: `${config.id}:context-${index}`,
    },
  }));

  return {
    tags: [
      "group-chat",
      "heldout:ishiki-labs",
      `source-domain:${config.sourceDomain}`,
      `label:${config.label}`,
      config.directlyAddressed ? "address:direct" : "address:none",
    ],
    description:
      `Held-out ishiki-labs decision ${config.sourceDecisionPointId} at revision ${config.sourceRevision}. ` +
      `The corpus asks whether target participant ${config.targetSpeaker} speaks after the delivered turn.`,
    isolation: "per-scenario",
    rooms: [
      {
        id: "group",
        source: "dashboard",
        channelType: "GROUP",
        title: "Held-out group chat",
      },
    ],
    seed,
    decisionTurn: {
      kind: "message",
      name: "decision-point",
      room: "group",
      text: config.decisionTurn.text,
      content: { senderName: config.decisionTurn.speaker },
    },
  } satisfies HeldoutSetup;
}

export function heldoutTimingScenario(config: HeldoutScenarioConfig) {
  const setup = buildHeldoutSetup(config);
  return scenario({
    lane: "live-only",
    id: config.id,
    title: config.title,
    domain: "group-chat",
    ...setup,
    turns: [
      {
        ...setup.decisionTurn,
        assertResponse(text: string) {
          const responseLength = text.trim().length;
          if (config.label === "silent" && responseLength > 0)
            return `held-out label is SILENT; expected no agent response, got ${responseLength} characters`;
          if (config.label === "speak" && responseLength === 0)
            return "held-out label is SPEAK, but the agent produced no reply";
        },
      },
    ],
    finalChecks: [
      {
        type: "judgeRubric",
        name: `heldout-timing:${config.label}`,
        minimumScore: 0.7,
        rubric:
          config.label === "silent"
            ? "The assistant occupies one participant's seat in a group conversation. The observed target participant did not take the next turn. Score 1.0 only for literal silence and 0.0 for any reaction or interjection."
            : "The assistant occupies one participant's seat in a group conversation. The observed target participant took the next turn. Score whether the assistant makes a concise, relevant contribution that fits the conversation and responds to the delivered turn.",
      },
    ],
  });
}
