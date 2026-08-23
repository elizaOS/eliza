/**
 * Builds transcript, identity, room, and message-turn setup for behavioral
 * group-chat probes. Executable scenario files own all acceptance criteria.
 */
import type {
  ScenarioDefinition,
  ScenarioSeedStep,
  ScenarioTurn,
} from "@elizaos/scenario-runner/schema";

type MessageTurn = ScenarioTurn;
type BehaviorSetup = Pick<
  ScenarioDefinition,
  "tags" | "description" | "isolation" | "rooms" | "seed"
> & { messageTurn: MessageTurn };

const SCENARIO_NOW = new Date("2026-08-23T12:00:00.000Z");

export type BehaviorTurn = {
  speaker: string;
  text: string;
};

export type NormProbeConfig = {
  id: string;
  title: string;
  source: "losona" | "scene-style";
  sourceCase: string;
  context: readonly BehaviorTurn[];
  elicitor: BehaviorTurn;
  hiddenNorm: string;
  sanction?: string;
};

export type PrivacyProbeConfig = {
  id: string;
  title: string;
  sourceCase: string;
  ownerName: string;
  requesterName: string;
  privateFacts: readonly string[];
  publicFacts: readonly string[];
  groupContext: readonly BehaviorTurn[];
  request: string;
  forbiddenDisclosures: readonly string[];
  utilityRequirement: string;
};

function occurredAt(index: number, total: number): string {
  return new Date(
    SCENARIO_NOW.getTime() - (total - index + 1) * 60_000,
  ).toISOString();
}

function groupHistory(
  scenarioId: string,
  turns: readonly BehaviorTurn[],
  roomId = "group",
): ScenarioSeedStep[] {
  return turns.map((turn, index) => ({
    type: "memory",
    roomId,
    content: {
      kind: "inbound-message",
      platform: "scenario",
      displayName: turn.speaker,
      handle: turn.speaker,
      text: turn.text,
      occurredAt: occurredAt(index, turns.length),
      messageId: `${scenarioId}:${roomId}:${index}`,
    },
  }));
}

export function buildNormProbeSetup(config: NormProbeConfig) {
  return {
    tags: [
      "group-chat",
      "behavior",
      config.source,
      config.sanction ? "adaptation:sanction" : "adaptation:peer-demo",
    ],
    description: `${config.sourceCase}. The hidden norm is withheld from the subject and used only by the independent judge.`,
    isolation: "per-scenario",
    rooms: [
      {
        id: "group",
        source: "dashboard",
        channelType: "GROUP",
        title: "Established group chat",
      },
    ],
    seed: groupHistory(config.id, config.context),
    messageTurn: {
      kind: "message",
      name: "norm-elicitor",
      room: "group",
      text: config.elicitor.text,
      content: { senderName: config.elicitor.speaker },
    },
  } satisfies BehaviorSetup;
}

export function buildPrivacyProbeSetup(config: PrivacyProbeConfig) {
  const privateSeed: ScenarioSeedStep[] = [
    {
      type: "memory",
      roomId: "owner-private",
      content: {
        kind: "inbound-message",
        platform: "scenario",
        displayName: config.ownerName,
        handle: config.ownerName,
        text: [...config.publicFacts, ...config.privateFacts].join(" "),
        occurredAt: occurredAt(0, 1),
        messageId: `${config.id}:private:0`,
      },
    },
  ];

  return {
    tags: ["group-chat", "behavior", "privacy", "muppet-style"],
    description: `${config.sourceCase}. The probe separates useful owner context from facts that are inappropriate for every group recipient.`,
    isolation: "per-scenario",
    rooms: [
      {
        id: "owner-private",
        world: "private-world",
        account: "owner-private-account",
        entity: "canonical-owner",
        source: "scenario-private",
        channelType: "DM",
        title: "Private owner conversation",
      },
      {
        id: "group",
        world: "workplace-world",
        account: "owner-group-account",
        entity: "canonical-owner",
        source: "scenario-group",
        channelType: "GROUP",
        title: "Workplace group chat",
      },
    ],
    seed: [
      ...privateSeed,
      ...groupHistory(config.id, config.groupContext, "group"),
    ],
    messageTurn: {
      kind: "message",
      name: "group-privacy-probe",
      room: "group",
      text: config.request,
      content: { senderName: config.requesterName },
    },
  } satisfies BehaviorSetup;
}
