/**
 * Builds transcript, room, and turn setup for generated group-chat timing
 * scenarios. Acceptance assertions and judge rubrics stay in each executable
 * scenario file so reviewers can inspect the contract without chasing a
 * shared factory.
 */
import type {
  ScenarioDefinition,
  ScenarioSeedStep,
  ScenarioTurn,
} from "@elizaos/scenario-runner/schema";

type MessageTurn = ScenarioTurn;
type GroupChatTimingSetup = Pick<
  ScenarioDefinition,
  "tags" | "description" | "isolation" | "rooms" | "seed"
> & { decisionTurn: MessageTurn };

/** Name the scenario runtime's character answers to; the generator substitutes
 * this for the corpus's `[AGENT]` placeholder so direct-address rows exercise
 * the real mention path (`textContainsAgentName`). */
export const GROUP_CHAT_AGENT_NAME = "ScenarioAgent";

export type GroupChatSpeakerTurn = {
  /** Anonymized human speaker id, e.g. "Speaker_2". */
  speaker: string;
  text: string;
};

export type GroupChatTimingScenarioConfig = {
  /** Static string literal at the call site — the loader reads it via AST. */
  id: string;
  title: string;
  /** Corpus label for the decision point. */
  label: "speak" | "silent";
  /** Whether the agent is named anywhere in the context (direct address). */
  directlyAddressed: boolean;
  /** Conversation history before the decision turn, oldest first. */
  context: GroupChatSpeakerTurn[];
  /** The final turn; the decision is whether the agent replies to it. */
  decisionTurn: GroupChatSpeakerTurn;
  /** For SPEAK rows: the corpus's gold intervention, fed to the judge rubric. */
  referenceIntervention?: string;
  /** Dataset provenance recorded in the description for auditability. */
  sourceRow: string;
};

/** Fixed logical clock; context turns are backdated one minute apart so the
 * recent-messages provider presents them in authored order. */
const SCENARIO_NOW = new Date("2026-08-20T19:00:00.000Z");

function contextOccurredAt(index: number, total: number): string {
  const minutesBefore = total - index + 1;
  return new Date(
    SCENARIO_NOW.getTime() - minutesBefore * 60_000,
  ).toISOString();
}

export function buildGroupChatTimingSetup(
  config: GroupChatTimingScenarioConfig,
) {
  const seeds: ScenarioSeedStep[] = config.context.map((turn, index) => ({
    type: "memory",
    name: `context-${index}`,
    content: {
      kind: "inbound-message",
      platform: "scenario",
      displayName: turn.speaker,
      handle: turn.speaker,
      text: turn.text,
      occurredAt: contextOccurredAt(index, config.context.length),
      messageId: `${config.id}:context-${index}`,
    },
  }));

  const speakers = new Set([
    ...config.context.map((turn) => turn.speaker),
    config.decisionTurn.speaker,
  ]);

  return {
    tags: [
      "group-chat",
      "when2speak",
      `label:${config.label}`,
      `speakers:${speakers.size}`,
      config.directlyAddressed ? "address:direct" : "address:none",
    ],
    description:
      `Intervention-timing decision point (${config.label.toUpperCase()}) from ${config.sourceRow}. ` +
      "The conversation history arrives from distinct human speakers; the assertion checks whether the agent speaks or stays silent at the decision turn.",
    isolation: "per-scenario",
    rooms: [
      {
        id: "group",
        source: "dashboard",
        channelType: "GROUP",
        title: "Group chat",
      },
    ],
    seed: seeds,
    decisionTurn: {
      kind: "message",
      name: "decision-point",
      room: "group",
      text: config.decisionTurn.text,
      content: { senderName: config.decisionTurn.speaker },
    },
  } satisfies GroupChatTimingSetup;
}
