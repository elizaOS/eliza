/**
 * Builds group-chat intervention-timing scenarios from labeled multi-party
 * decision points (When2Speak-style SPEAK/SILENT rows). Each scenario seeds the
 * conversation history as inbound-message memories from distinct human
 * speakers, delivers the final context turn live, and asserts the agent's
 * respond/stay-silent decision against the corpus label.
 *
 * Silence is asserted the way the conversation-quality corpus does it: the
 * runner has no first-class "no message produced" primitive, so a SILENT label
 * tolerates at most a reaction-tier ack (tight length budget) and a judge
 * rubric grades the restraint. A SPEAK label requires a non-empty substantive
 * reply and the rubric grades whether the interjection was apt, using the
 * corpus's reference intervention as the gold flavor.
 */
import type { ScenarioSeedStep } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

/** Name the scenario runtime's character answers to; the generator substitutes
 * this for the corpus's `[AGENT]` placeholder so direct-address rows exercise
 * the real mention path (`textContainsAgentName`). */
export const GROUP_CHAT_AGENT_NAME = "ScenarioAgent";

/** Max characters a SILENT-labeled turn may emit before it counts as an
 * interjection. Mirrors the deployment convention asserted in
 * `conversation-quality/convq.group-restraint`: silence or a reaction-tier ack. */
export const SILENT_ACK_BUDGET_CHARS = 120;

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

export function buildGroupChatTimingScenario(
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

  const silentAssert = (text: string): string | undefined => {
    if (text && text.trim().length > SILENT_ACK_BUDGET_CHARS) {
      return `label is SILENT — the conversation flows without the agent; expected silence or a reaction-tier ack (<=${SILENT_ACK_BUDGET_CHARS} chars), got ${text.trim().length}`;
    }
    return undefined;
  };

  const speakAssert = (text: string): string | undefined => {
    if (!text || text.trim().length === 0) {
      return "label is SPEAK — an apt intervention was expected here, got no reply";
    }
    return undefined;
  };

  const silentRubric =
    "This is a group chat between human participants. The final message is " +
    "them talking to each other — no reply from the assistant is expected. " +
    "Score 1.0 if the assistant stayed silent or emitted at most a one-line " +
    "reaction-tier ack; score 0.0 if it inserted a substantive contribution, " +
    "commentary, agreement, or a question that keeps the conversation going.";

  const speakRubric =
    "This is a group chat between human participants, and the final message " +
    "is a moment where an assistant participant should genuinely intervene " +
    `(${config.directlyAddressed ? "it is directly addressed" : "not by name, but the conversation needs what it can add"}). ` +
    "Score on whether the reply is a substantive, on-topic intervention that " +
    "moves the conversation forward — answering the open question, supplying " +
    "the missing fact, or synthesizing the thread — in a register that fits " +
    "casual group chat (concise, no lecture, no list dump)." +
    (config.referenceIntervention
      ? ` A reference intervention from the corpus (gold flavor, not required wording): ${JSON.stringify(config.referenceIntervention)}`
      : "");

  return scenario({
    lane: "live-only",
    id: config.id,
    title: config.title,
    domain: "group-chat",
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
    now: SCENARIO_NOW.toISOString(),
    rooms: [
      {
        id: "group",
        source: "dashboard",
        channelType: "GROUP",
        title: "Group chat",
      },
    ],
    seed: seeds,
    turns: [
      {
        kind: "message",
        name: "decision-point",
        room: "group",
        text: config.decisionTurn.text,
        content: { senderName: config.decisionTurn.speaker },
        assertResponse: config.label === "silent" ? silentAssert : speakAssert,
      },
    ],
    finalChecks: [
      {
        type: "judgeRubric",
        name: `timing:${config.label}`,
        minimumScore: 0.7,
        rubric: config.label === "silent" ? silentRubric : speakRubric,
      },
    ],
  });
}
