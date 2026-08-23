/**
 * Builds held-out intervention scenarios without coupling their metadata to the
 * primary When2Speak corpus. Generated ishiki-labs cases use this factory so
 * reports retain the source corpus and label provenance.
 */
import type { ScenarioSeedStep } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

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
const SILENT_ACK_BUDGET_CHARS = 120;

export function buildHeldoutScenario(config: HeldoutScenarioConfig) {
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

  const assertResponse = (text: string): string | undefined => {
    const responseLength = text.trim().length;
    if (config.label === "speak" && responseLength === 0) {
      return "held-out label is SPEAK, but the agent produced no reply";
    }
    if (config.label === "silent" && responseLength > SILENT_ACK_BUDGET_CHARS) {
      return `held-out label is SILENT; expected silence or an ack no longer than ${SILENT_ACK_BUDGET_CHARS} characters, got ${responseLength}`;
    }
    return undefined;
  };

  return scenario({
    lane: "live-only",
    id: config.id,
    title: config.title,
    domain: "group-chat",
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
    now: NOW.toISOString(),
    rooms: [
      {
        id: "group",
        source: "dashboard",
        channelType: "GROUP",
        title: "Held-out group chat",
      },
    ],
    seed,
    turns: [
      {
        kind: "message",
        name: "decision-point",
        room: "group",
        text: `[${config.decisionTurn.speaker}] ${config.decisionTurn.text}`,
        assertResponse,
      },
    ],
    finalChecks: [
      {
        type: "judgeRubric",
        name: `heldout-timing:${config.label}`,
        minimumScore: 0.7,
        rubric:
          config.label === "silent"
            ? "The assistant occupies one participant's seat in a group conversation. The observed target participant did not take the next turn. Score 1.0 for silence or a brief reaction-tier acknowledgment. Score 0.0 for a substantive interjection."
            : "The assistant occupies one participant's seat in a group conversation. The observed target participant took the next turn. Score whether the assistant makes a concise, relevant contribution that fits the conversation and responds to the delivered turn.",
      },
    ],
  });
}
