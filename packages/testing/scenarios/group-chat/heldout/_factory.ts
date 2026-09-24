/**
 * Builds transcript, room, and turn setup for held-out intervention scenarios.
 * Executable files retain their own assertions and judge rubrics.
 */
import type {
  ScenarioDefinition,
  ScenarioSeedStep,
  ScenarioTurn,
} from "@elizaos/scenario-runner/schema";

type MessageTurn = ScenarioTurn;
type HeldoutSetup = Pick<
  ScenarioDefinition,
  "tags" | "description" | "isolation" | "rooms" | "seed"
> & { decisionTurn: MessageTurn };

export type HeldoutTurn = { speaker: string; text: string };

export type HeldoutScenarioConfig = {
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
