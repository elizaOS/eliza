import type {
  Action,
  ActionParameters,
  ActionResult,
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  Room,
  State,
  UUID,
} from "@elizaos/core";
import type { TownAgent, Vector2 } from "../../shared/types";
import {
  DEFAULT_AUDIO_RANGE_TILES,
  DEFAULT_VISION_RANGE_TILES,
} from "../../shared/types";
import { defaultWorldMap } from "../../shared/worldMap";
import type { MafiaNightActionType } from "../simulation/mafiaGame";
import {
  emoteTownAgent,
  getTownContextSnapshot,
  getTownGameView,
  queueTownMove,
  stopTownAgent,
  submitTownNightAction,
  submitTownVote,
} from "../simulation/townContext";
import type { MoveRequest } from "../simulation/townSimulation";

const PROVIDER_NAME = "ELIZA_TOWN";
const ACTION_NAME = "MOVE";
const ROLE_PROVIDER_NAME = "MAFIA_ROLE";
const GAME_PROVIDER_NAME = "MAFIA_GAME";
const ROOM_MESSAGES_PROVIDER_NAME = "ROOM_MESSAGES";
const OBJECTIVES_PROVIDER_NAME = "TOWN_OBJECTIVES";
const NEAR_RANGE_TILES = 3;
const NEXT_TO_RANGE_TILES = 1;

const townProvider: Provider = {
  name: PROVIDER_NAME,
  description: "Town map, agents, and points of interest for Eliza Town.",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const snapshot = getTownContextSnapshot();
    if (!snapshot) {
      return {
        text: "[ELIZA_TOWN]\nTown simulation unavailable.\n[/ELIZA_TOWN]",
        values: { townAvailable: false },
        data: { townAvailable: false },
      };
    }

    const { state, pointsOfInterest } = snapshot;
    const currentAgent = resolveAgentFromSnapshot(state.agents, runtime);

    if (!currentAgent) {
      const mapText = [
        "[ELIZA_TOWN]",
        `Map size: ${defaultWorldMap.width}x${defaultWorldMap.height}`,
        `Map bounds: (0,0) to (${defaultWorldMap.width - 1},${defaultWorldMap.height - 1})`,
        `You: ${runtime.character?.name ?? "Agent"} @ unknown`,
        "",
        "Visibility: unavailable (agent position unknown).",
        "[/ELIZA_TOWN]",
      ].join("\n");
      return {
        text: mapText,
        values: {
          townAvailable: true,
          currentAgentId: null,
          currentAgentName: null,
          currentAgentX: null,
          currentAgentY: null,
          poiCount: pointsOfInterest.length,
          agentCount: state.agents.length,
          visibleAgentCount: 0,
          visiblePoiCount: 0,
          visionRangeTiles: DEFAULT_VISION_RANGE_TILES,
          audioRangeTiles: DEFAULT_AUDIO_RANGE_TILES,
          mapWidth: defaultWorldMap.width,
          mapHeight: defaultWorldMap.height,
        },
        data: {
          townAvailable: true,
          currentAgent: null,
          visibleAgents: [],
          visiblePointsOfInterest: [],
          visibility: {
            nextTo: [],
            near: [],
            far: [],
            outOfSightAgents: state.agents.length,
            outOfSightPoi: pointsOfInterest.length,
          },
          map: {
            width: defaultWorldMap.width,
            height: defaultWorldMap.height,
          },
        },
      };
    }

    const visionRangeTiles =
      currentAgent.visionRangeTiles ?? DEFAULT_VISION_RANGE_TILES;
    const audioRangeTiles =
      currentAgent.audioRangeTiles ?? DEFAULT_AUDIO_RANGE_TILES;
    const visibility = buildVisibilitySnapshot(
      currentAgent.position,
      state.agents,
      pointsOfInterest,
      visionRangeTiles,
    );
    const mapText = [
      "[ELIZA_TOWN]",
      `Map size: ${defaultWorldMap.width}x${defaultWorldMap.height}`,
      `Map bounds: (0,0) to (${defaultWorldMap.width - 1},${defaultWorldMap.height - 1})`,
      `You: ${currentAgent.name} (${currentAgent.id}) @ ${formatCoord(currentAgent.position)}`,
      `Status: ${currentAgent.status}`,
      `Task: ${currentAgent.lastAction ?? "none"}`,
      `Vision radius: ${visionRangeTiles} tiles`,
      `Hearing radius: ${audioRangeTiles} tiles`,
      "",
      "Visibility:",
      `Next to you: ${formatVisibilityLine(visibility.nextTo)}`,
      `Near you: ${formatVisibilityLine(visibility.near)}`,
      `Far away (within sight): ${formatVisibilityLine(visibility.far)}`,
      `Out of sight: ${visibility.outOfSightAgents} agents, ${visibility.outOfSightPoi} points of interest`,
      "[/ELIZA_TOWN]",
    ].join("\n");

    return {
      text: mapText,
      values: {
        townAvailable: true,
        currentAgentId: currentAgent?.id ?? null,
        currentAgentName: currentAgent?.name ?? null,
        currentAgentX: currentAgent?.position.x ?? null,
        currentAgentY: currentAgent?.position.y ?? null,
        poiCount: pointsOfInterest.length,
        agentCount: state.agents.length,
        visibleAgentCount: visibility.visibleAgents.length,
        visiblePoiCount: visibility.visiblePois.length,
        visionRangeTiles,
        audioRangeTiles,
        mapWidth: defaultWorldMap.width,
        mapHeight: defaultWorldMap.height,
      },
      data: {
        townAvailable: true,
        currentAgent,
        visibleAgents: visibility.visibleAgents,
        visiblePointsOfInterest: visibility.visiblePois,
        visibility: {
          nextTo: visibility.nextTo,
          near: visibility.near,
          far: visibility.far,
          outOfSightAgents: visibility.outOfSightAgents,
          outOfSightPoi: visibility.outOfSightPoi,
        },
        map: {
          width: defaultWorldMap.width,
          height: defaultWorldMap.height,
        },
      },
    };
  },
};

const mafiaRoleProvider: Provider = {
  name: ROLE_PROVIDER_NAME,
  description: "Your secret role and objectives in the mafia game.",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const snapshot = getTownContextSnapshot();
    if (!snapshot) {
      return {
        text: "[MAFIA_ROLE]\nTown simulation unavailable.\n[/MAFIA_ROLE]",
        values: { mafiaAvailable: false },
        data: { mafiaAvailable: false },
      };
    }
    const currentAgent = resolveAgentFromSnapshot(
      snapshot.state.agents,
      runtime,
    );
    if (!currentAgent) {
      return {
        text: "[MAFIA_ROLE]\nRole unavailable (agent not found).\n[/MAFIA_ROLE]",
        values: { mafiaAvailable: false },
        data: { mafiaAvailable: false },
      };
    }
    const gameView = getTownGameView(currentAgent.id);
    if (!gameView) {
      return {
        text: "[MAFIA_ROLE]\nGame state unavailable.\n[/MAFIA_ROLE]",
        values: { mafiaAvailable: false },
        data: { mafiaAvailable: false },
      };
    }
    const roleBrief = gameView.you.roleBrief;
    const investigation = gameView.you.lastInvestigation;
    const nameLookup = buildAgentNameLookup(snapshot.state.agents);
    const investigationLabel = investigation
      ? (nameLookup.get(investigation.target) ?? investigation.target)
      : null;
    const roleText = [
      "[MAFIA_ROLE]",
      `Role: ${roleBrief.name}`,
      `Alive: ${gameView.you.alive ? "yes" : "no"}`,
      "",
      "Objectives:",
      ...roleBrief.goals.map((goal) => `- ${goal}`),
      "",
      "Night action:",
      roleBrief.nightAction
        ? `Use ${formatNightAction(roleBrief.nightAction)}.`
        : "None.",
      "",
      investigation
        ? `Last investigation: ${investigationLabel} is ${
            investigation.isMafia ? "mafia" : "not mafia"
          }.`
        : "Last investigation: none.",
      "[/MAFIA_ROLE]",
    ].join("\n");
    return {
      text: roleText,
      values: {
        mafiaAvailable: true,
        role: roleBrief.role,
        alive: gameView.you.alive,
        phase: gameView.phase,
        round: gameView.round,
        canKill: gameView.availableActions.canKill,
        canInvestigate: gameView.availableActions.canInvestigate,
        canProtect: gameView.availableActions.canProtect,
        canVote: gameView.availableActions.canVote,
      },
      data: {
        mafiaAvailable: true,
        role: roleBrief,
        investigation,
        availableActions: gameView.availableActions,
      },
    };
  },
};

const mafiaGameProvider: Provider = {
  name: GAME_PROVIDER_NAME,
  description: "Public game phase, eliminations, and action windows.",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const snapshot = getTownContextSnapshot();
    if (!snapshot) {
      return {
        text: "[MAFIA_GAME]\nTown simulation unavailable.\n[/MAFIA_GAME]",
        values: { mafiaAvailable: false },
        data: { mafiaAvailable: false },
      };
    }
    const currentAgent = resolveAgentFromSnapshot(
      snapshot.state.agents,
      runtime,
    );
    if (!currentAgent) {
      return {
        text: "[MAFIA_GAME]\nGame state unavailable (agent not found).\n[/MAFIA_GAME]",
        values: { mafiaAvailable: false },
        data: { mafiaAvailable: false },
      };
    }
    const gameView = getTownGameView(currentAgent.id);
    if (!gameView) {
      return {
        text: "[MAFIA_GAME]\nGame state unavailable.\n[/MAFIA_GAME]",
        values: { mafiaAvailable: false },
        data: { mafiaAvailable: false },
      };
    }
    const nameLookup = buildAgentNameLookup(snapshot.state.agents);
    const aliveNames = gameView.publicPlayers
      .filter((player) => player.alive)
      .map((player) => nameLookup.get(player.agentId) ?? player.agentId);
    const eliminations = gameView.eliminations.map((entry) => {
      const name = nameLookup.get(entry.agentId) ?? entry.agentId;
      return `${name} (${entry.revealedRole}) - ${entry.reason}`;
    });
    const gameText = [
      "[MAFIA_GAME]",
      `Phase: ${gameView.phase}`,
      `Round: ${gameView.round}`,
      `Paused: ${gameView.isPaused ? "yes" : "no"}`,
      `Winner: ${gameView.winner}`,
      `Last event: ${gameView.lastEvent ?? "none"}`,
      "",
      `Alive: ${aliveNames.length > 0 ? aliveNames.join(", ") : "none"}`,
      `Eliminations: ${eliminations.length > 0 ? eliminations.join("; ") : "none"}`,
      "",
      `Actions: vote=${gameView.availableActions.canVote ? "yes" : "no"}, kill=${
        gameView.availableActions.canKill ? "yes" : "no"
      }, investigate=${gameView.availableActions.canInvestigate ? "yes" : "no"}, protect=${
        gameView.availableActions.canProtect ? "yes" : "no"
      }`,
      "[/MAFIA_GAME]",
    ].join("\n");
    return {
      text: gameText,
      values: {
        mafiaAvailable: true,
        phase: gameView.phase,
        round: gameView.round,
        isPaused: gameView.isPaused,
        winner: gameView.winner,
        aliveCount: aliveNames.length,
      },
      data: {
        mafiaAvailable: true,
        phase: gameView.phase,
        round: gameView.round,
        isPaused: gameView.isPaused,
        winner: gameView.winner,
        aliveAgentIds: gameView.publicPlayers
          .filter((player) => player.alive)
          .map((p) => p.agentId),
        eliminations: gameView.eliminations,
        availableActions: gameView.availableActions,
      },
    };
  },
};

const objectivesProvider: Provider = {
  name: OBJECTIVES_PROVIDER_NAME,
  description: "Round objectives and tasks to keep townsfolk busy.",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const snapshot = getTownContextSnapshot();
    if (!snapshot) {
      return {
        text: `[${OBJECTIVES_PROVIDER_NAME}]\nObjectives unavailable.\n[/${OBJECTIVES_PROVIDER_NAME}]`,
        values: { objectivesAvailable: false },
        data: { objectivesAvailable: false },
      };
    }
    const objectives = snapshot.state.objectives ?? [];
    const currentAgent = resolveAgentFromSnapshot(
      snapshot.state.agents,
      runtime,
    );
    const assignedObjectives = currentAgent
      ? objectives.filter((objective) =>
          objective.assignedAgentIds.includes(currentAgent.id),
        )
      : [];
    const completedCount = objectives.filter(
      (objective) => objective.status === "completed",
    ).length;
    const assignedCompleted = assignedObjectives.filter(
      (objective) => objective.status === "completed",
    ).length;
    const round = assignedObjectives[0]?.round ?? objectives[0]?.round ?? 0;
    const poiNames = new Map(
      snapshot.pointsOfInterest.map((poi) => [poi.id, poi.name]),
    );
    const lines =
      assignedObjectives.length > 0
        ? assignedObjectives.map((objective) => {
            const statusIcon = objective.status === "completed" ? "✓" : "•";
            const poiLabel = objective.poiId
              ? (poiNames.get(objective.poiId) ?? objective.poiId)
              : "unknown";
            return `${statusIcon} ${objective.title} @ ${poiLabel} ${formatCoord(objective.location)}`;
          })
        : ["(no assigned objectives)"];
    return {
      text: [
        `[${OBJECTIVES_PROVIDER_NAME}]`,
        `Round: ${round}`,
        `Progress: ${completedCount}/${objectives.length} objectives completed.`,
        `Your objectives (${assignedCompleted}/${assignedObjectives.length}):`,
        ...lines,
        `[/${OBJECTIVES_PROVIDER_NAME}]`,
      ].join("\n"),
      values: {
        objectivesAvailable: true,
        objectiveCount: objectives.length,
        objectiveCompleted: completedCount,
        assignedCount: assignedObjectives.length,
        assignedCompleted,
        round,
      },
      data: {
        objectivesAvailable: true,
        objectives,
        assignedObjectives,
      },
    };
  },
};

const moveAction: Action = {
  name: ACTION_NAME,
  description:
    "Move to a target in Eliza Town. Targets can be an agent, a player, a point of interest, or coordinates.",
  parameters: [
    {
      name: "target",
      description: "Agent name/id, POI name/id, or coordinates like '12,8'.",
      required: false,
      schema: { type: "string" },
      examples: ["market", "eliza-ranger", "12,8"],
    },
    {
      name: "x",
      description: "X coordinate for coordinate moves.",
      required: false,
      schema: { type: "number" },
      examples: [12],
    },
    {
      name: "y",
      description: "Y coordinate for coordinate moves.",
      required: false,
      schema: { type: "number" },
      examples: [8],
    },
  ],
  validate: async (): Promise<boolean> => {
    return getTownContextSnapshot() !== null;
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: { parameters?: ActionParameters },
  ): Promise<ActionResult> => {
    const params = options?.parameters;
    const agentId = resolveRuntimeAgentKey(runtime);
    const request = buildMoveRequest(agentId, params);
    if (!request) {
      return { success: false, text: "Invalid MOVE parameters." };
    }

    const result = queueTownMove(request);
    return {
      success: result.success,
      text: result.message,
      data: { target: result.target },
      values: { moved: result.success },
    };
  },
};

const mafiaVoteAction: Action = {
  name: "MAFIA_VOTE",
  description: "Vote to eliminate a player during the day phase.",
  parameters: [
    {
      name: "target",
      description: "Agent ID or name to vote out.",
      required: true,
      schema: { type: "string" },
      examples: ["alex-rivera", "Briar Holt"],
    },
  ],
  validate: async (): Promise<boolean> => {
    return getTownContextSnapshot() !== null;
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: { parameters?: ActionParameters },
  ): Promise<ActionResult> => {
    const snapshot = getTownContextSnapshot();
    if (!snapshot) {
      return { success: false, text: "Town simulation unavailable." };
    }
    const actor = resolveAgentFromSnapshot(snapshot.state.agents, runtime);
    if (!actor) {
      return { success: false, text: "Unable to resolve voting agent." };
    }
    const targetValue = readString(options?.parameters?.target);
    if (!targetValue) {
      return { success: false, text: "Missing target for MAFIA_VOTE." };
    }
    const target = findAgentByIdentifier(targetValue, snapshot.state.agents);
    if (!target) {
      return { success: false, text: "Target not found." };
    }
    const result = submitTownVote(actor.id, target.id);
    return {
      success: result.success,
      text: result.message,
      data: { target: target.id },
      values: { voted: result.success },
    };
  },
};

const mafiaKillAction: Action = {
  name: "MAFIA_KILL",
  description: "Mafia-only night action to choose a kill target.",
  parameters: [
    {
      name: "target",
      description: "Agent ID or name to eliminate.",
      required: true,
      schema: { type: "string" },
      examples: ["alex-rivera", "Briar Holt"],
    },
  ],
  validate: async (): Promise<boolean> => {
    return getTownContextSnapshot() !== null;
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: { parameters?: ActionParameters },
  ): Promise<ActionResult> => {
    return handleNightAction(runtime, options?.parameters, "kill");
  },
};

const mafiaInvestigateAction: Action = {
  name: "MAFIA_INVESTIGATE",
  description: "Detective-only night action to investigate a player.",
  parameters: [
    {
      name: "target",
      description: "Agent ID or name to investigate.",
      required: true,
      schema: { type: "string" },
      examples: ["alex-rivera", "Briar Holt"],
    },
  ],
  validate: async (): Promise<boolean> => {
    return getTownContextSnapshot() !== null;
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: { parameters?: ActionParameters },
  ): Promise<ActionResult> => {
    return handleNightAction(runtime, options?.parameters, "investigate");
  },
};

const mafiaProtectAction: Action = {
  name: "MAFIA_PROTECT",
  description: "Doctor-only night action to protect a player.",
  parameters: [
    {
      name: "target",
      description: "Agent ID or name to protect.",
      required: true,
      schema: { type: "string" },
      examples: ["alex-rivera", "Briar Holt"],
    },
  ],
  validate: async (): Promise<boolean> => {
    return getTownContextSnapshot() !== null;
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: { parameters?: ActionParameters },
  ): Promise<ActionResult> => {
    return handleNightAction(runtime, options?.parameters, "protect");
  },
};

const stopAction: Action = {
  name: "STOP",
  description: "Stop moving and clear your current route.",
  parameters: [],
  validate: async (): Promise<boolean> => {
    return getTownContextSnapshot() !== null;
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ActionResult> => {
    const snapshot = getTownContextSnapshot();
    if (!snapshot) {
      return { success: false, text: "Town simulation unavailable." };
    }
    const actor = resolveAgentFromSnapshot(snapshot.state.agents, runtime);
    if (!actor) {
      return { success: false, text: "Unable to resolve agent." };
    }
    const result = stopTownAgent(actor.id);
    return {
      success: result.success,
      text: result.message,
      values: { stopped: result.success },
    };
  },
};

const emoteAction: Action = {
  name: "EMOTE",
  description: "Show an emoji emote above your head.",
  parameters: [
    {
      name: "emoji",
      description: "Emoji to show (e.g. 🙂, 🔥, ✨).",
      required: true,
      schema: { type: "string" },
      examples: ["🙂", "✨"],
    },
  ],
  validate: async (): Promise<boolean> => {
    return getTownContextSnapshot() !== null;
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: { parameters?: ActionParameters },
  ): Promise<ActionResult> => {
    const snapshot = getTownContextSnapshot();
    if (!snapshot) {
      return { success: false, text: "Town simulation unavailable." };
    }
    const actor = resolveAgentFromSnapshot(snapshot.state.agents, runtime);
    if (!actor) {
      return { success: false, text: "Unable to resolve agent." };
    }
    const emoji = readEmoteValue(options?.parameters);
    if (!emoji) {
      return { success: false, text: "Missing emoji for EMOTE." };
    }
    const result = emoteTownAgent(actor.id, emoji);
    return {
      success: result.success,
      text: result.message,
      values: { emote: result.success },
      data: { emoji },
    };
  },
};

const roomMessagesProvider: Provider = {
  name: ROOM_MESSAGES_PROVIDER_NAME,
  description: "Recent messages across all rooms the agent is in.",
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const roomIds = await runtime.getRoomsForParticipant(runtime.agentId);
    if (roomIds.length === 0) {
      throw new Error("No rooms found for agent.");
    }
    const rooms = await runtime.getRoomsByIds(roomIds);
    if (!rooms) {
      throw new Error("Unable to load room details for agent.");
    }

    const roomsById = new Map<UUID, Room>();
    const autonomyRoomIds = new Set<UUID>();
    for (const room of rooms) {
      roomsById.set(room.id, room);
      if (isAutonomyRoom(room)) {
        autonomyRoomIds.add(room.id);
      }
    }

    const perRoomLimit = Math.max(1, runtime.getConversationLength());
    const memories = await runtime.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds,
      limit: perRoomLimit * roomIds.length,
    });

    const sortedMemories = [...memories].sort(
      (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
    );
    const memoriesByRoom = new Map<UUID, Memory[]>();
    for (const memory of sortedMemories) {
      const roomBucket = memoriesByRoom.get(memory.roomId) ?? [];
      if (roomBucket.length >= perRoomLimit) {
        continue;
      }
      roomBucket.push(memory);
      memoriesByRoom.set(memory.roomId, roomBucket);
    }

    const entityIds = new Set<UUID>();
    for (const memory of sortedMemories) {
      entityIds.add(memory.entityId);
    }
    const entityNames = await buildEntityNameLookup(runtime, entityIds);

    const roomSummaries: Array<{
      roomId: UUID;
      roomName: string;
      messages: string[];
    }> = [];
    const autonomyThoughts: string[] = [];

    for (const roomId of roomIds) {
      const room = roomsById.get(roomId);
      const roomName = room?.name ?? String(roomId);
      const roomMemories = memoriesByRoom.get(roomId) ?? [];
      if (autonomyRoomIds.has(roomId)) {
        for (const memory of roomMemories) {
          if (memory.entityId !== runtime.agentId) {
            continue;
          }
          const text = readMemoryText(memory);
          if (text) {
            autonomyThoughts.push(text);
          }
        }
        continue;
      }
      const lines: string[] = [];
      for (const memory of roomMemories) {
        if (memory.entityId === runtime.agentId) {
          continue;
        }
        const authorName = entityNames.get(memory.entityId) ?? "Unknown";
        const text = readMemoryText(memory);
        if (!text) {
          continue;
        }
        lines.push(`${authorName}: ${text}`);
      }
      roomSummaries.push({ roomId, roomName, messages: lines });
    }

    const roomsText = roomSummaries
      .map((room) => {
        const lines =
          room.messages.length > 0 ? room.messages : ["(no recent messages)"];
        return [`Room: ${room.roomName}`, ...lines].join("\n");
      })
      .join("\n\n");
    const autonomyText =
      autonomyThoughts.length > 0
        ? ["Recent autonomous thoughts:", ...autonomyThoughts].join("\n")
        : "Recent autonomous thoughts: (none)";

    return {
      text: [
        `[${ROOM_MESSAGES_PROVIDER_NAME}]`,
        roomsText || "No recent room messages.",
        autonomyText,
        `[/${ROOM_MESSAGES_PROVIDER_NAME}]`,
      ].join("\n"),
      values: {
        roomCount: roomIds.length,
        autonomyRoomCount: autonomyRoomIds.size,
      },
      data: {
        roomCount: roomIds.length,
        autonomyRoomCount: autonomyRoomIds.size,
        rooms: roomSummaries,
        autonomyThoughts,
        targetRoomId: message.roomId,
      },
    };
  },
};

export const elizaTownPlugin = {
  name: "eliza-town",
  description: "Eliza Town provider and MOVE action for ai-town.",
  providers: [
    townProvider,
    mafiaRoleProvider,
    mafiaGameProvider,
    roomMessagesProvider,
    objectivesProvider,
  ],
  actions: [
    moveAction,
    stopAction,
    emoteAction,
    mafiaVoteAction,
    mafiaKillAction,
    mafiaInvestigateAction,
    mafiaProtectAction,
  ],
};

export default elizaTownPlugin;

type VisibilityBand = "next_to" | "near" | "far";

type VisibleAgent = {
  id: string;
  name: string;
  position: Vector2;
  distance: number;
  band: VisibilityBand;
};

type VisiblePoi = {
  id: string;
  name: string;
  emoji: string;
  position: Vector2;
  distance: number;
  band: VisibilityBand;
};

type VisibilityBucketEntry = {
  label: string;
  distance: number;
  kind: "agent" | "poi";
};

type VisibilitySnapshot = {
  visibleAgents: VisibleAgent[];
  visiblePois: VisiblePoi[];
  nextTo: VisibilityBucketEntry[];
  near: VisibilityBucketEntry[];
  far: VisibilityBucketEntry[];
  outOfSightAgents: number;
  outOfSightPoi: number;
};

function buildVisibilitySnapshot(
  origin: Vector2,
  agents: Array<{ id: string; name: string; position: Vector2 }>,
  pointsOfInterest: Array<{
    id: string;
    name: string;
    emoji: string;
    position: Vector2;
  }>,
  visionRangeTiles: number,
): VisibilitySnapshot {
  const visibleAgents: VisibleAgent[] = [];
  const visiblePois: VisiblePoi[] = [];
  const buckets: Record<VisibilityBand, VisibilityBucketEntry[]> = {
    next_to: [],
    near: [],
    far: [],
  };
  for (const agent of agents) {
    if (agent.position.x === origin.x && agent.position.y === origin.y) {
      continue;
    }
    const distance = distanceTiles(origin, agent.position);
    const band = getVisibilityBand(distance, visionRangeTiles);
    if (!band) {
      continue;
    }
    visibleAgents.push({
      id: agent.id,
      name: agent.name,
      position: agent.position,
      distance,
      band,
    });
    buckets[band].push({
      label: agent.name,
      distance,
      kind: "agent",
    });
  }
  for (const poi of pointsOfInterest) {
    const distance = distanceTiles(origin, poi.position);
    const band = getVisibilityBand(distance, visionRangeTiles);
    if (!band) {
      continue;
    }
    visiblePois.push({
      id: poi.id,
      name: poi.name,
      emoji: poi.emoji,
      position: poi.position,
      distance,
      band,
    });
    buckets[band].push({
      label: `${poi.name} ${poi.emoji}`,
      distance,
      kind: "poi",
    });
  }
  return {
    visibleAgents,
    visiblePois,
    nextTo: buckets.next_to,
    near: buckets.near,
    far: buckets.far,
    outOfSightAgents: Math.max(0, agents.length - 1 - visibleAgents.length),
    outOfSightPoi: Math.max(0, pointsOfInterest.length - visiblePois.length),
  };
}

function formatVisibilityLine(entries: VisibilityBucketEntry[]): string {
  if (entries.length === 0) {
    return "none";
  }
  return entries.map((entry) => formatVisibilityEntry(entry)).join("; ");
}

function formatVisibilityEntry(entry: VisibilityBucketEntry): string {
  const distance = formatDistance(entry.distance);
  return `${entry.label} (${distance})`;
}

function formatDistance(distance: number): string {
  return distance === 1 ? "1 tile" : `${distance} tiles`;
}

function distanceTiles(a: Vector2, b: Vector2): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return Math.max(dx, dy);
}

function getVisibilityBand(
  distance: number,
  visionRangeTiles: number,
): VisibilityBand | null {
  if (distance <= NEXT_TO_RANGE_TILES) {
    return "next_to";
  }
  if (distance <= Math.min(NEAR_RANGE_TILES, visionRangeTiles)) {
    return "near";
  }
  if (distance <= visionRangeTiles) {
    return "far";
  }
  return null;
}

function resolveAgentFromSnapshot(
  agents: TownAgent[],
  runtime: IAgentRuntime,
): TownAgent | null {
  const agentKey = resolveRuntimeAgentKey(runtime);
  return (
    agents.find(
      (agent) =>
        agent.id.toLowerCase() === agentKey.toLowerCase() ||
        agent.name.toLowerCase() === agentKey.toLowerCase(),
    ) ?? null
  );
}

function isAutonomyRoom(room: Room): boolean {
  const metaType = room.metadata?.type;
  const metaTypeString =
    typeof metaType === "string" ? metaType.toLowerCase() : "";
  return metaTypeString === "autonomous" || room.name === "Autonomous Thoughts";
}

function readMemoryText(memory: Memory): string | null {
  const text = memory.content?.text;
  return typeof text === "string" && text.trim().length > 0
    ? text.trim()
    : null;
}

async function buildEntityNameLookup(
  runtime: IAgentRuntime,
  entityIds: Set<UUID>,
): Promise<Map<UUID, string>> {
  const entries = await Promise.all(
    Array.from(entityIds).map(async (entityId) => {
      if (!runtime.getEntityById) {
        return [entityId, String(entityId)] as const;
      }
      const entity = await runtime.getEntityById(entityId);
      const name =
        entity && Array.isArray(entity.names) && entity.names.length > 0
          ? (entity.names[0] ?? String(entityId))
          : String(entityId);
      return [entityId, name] as const;
    }),
  );
  return new Map(entries);
}

function buildAgentNameLookup(
  agents: Array<{ id: string; name: string }>,
): Map<string, string> {
  return new Map(agents.map((agent) => [agent.id, agent.name]));
}

function formatNightAction(action: MafiaNightActionType): string {
  if (action === "kill") {
    return "MAFIA_KILL";
  }
  if (action === "investigate") {
    return "MAFIA_INVESTIGATE";
  }
  return "MAFIA_PROTECT";
}

function handleNightAction(
  runtime: IAgentRuntime,
  params: ActionParameters | undefined,
  actionType: MafiaNightActionType,
): ActionResult {
  const snapshot = getTownContextSnapshot();
  if (!snapshot) {
    return { success: false, text: "Town simulation unavailable." };
  }
  const actor = resolveAgentFromSnapshot(snapshot.state.agents, runtime);
  if (!actor) {
    return { success: false, text: "Unable to resolve agent." };
  }
  const targetValue = readString(params?.target);
  if (!targetValue) {
    return { success: false, text: "Missing target for night action." };
  }
  const target = findAgentByIdentifier(targetValue, snapshot.state.agents);
  if (!target) {
    return { success: false, text: "Target not found." };
  }
  if (target.id === actor.id) {
    return { success: false, text: "Cannot target yourself." };
  }
  const result = submitTownNightAction({
    actorId: actor.id,
    type: actionType,
    target: target.id,
  });
  return {
    success: result.success,
    text: result.message,
    data: { target: target.id, action: actionType },
    values: { submitted: result.success },
  };
}

function resolveRuntimeAgentKey(runtime: IAgentRuntime): string {
  const username = runtime.character?.username;
  if (typeof username === "string" && username.trim().length > 0) {
    return username.trim();
  }
  const name = runtime.character?.name;
  if (typeof name === "string" && name.trim().length > 0) {
    return name.trim();
  }
  return runtime.agentId;
}

function formatCoord(position: { x: number; y: number }): string {
  return `(${position.x},${position.y})`;
}

function buildMoveRequest(
  agentId: string,
  params?: ActionParameters,
): MoveRequest | null {
  const x = readNumber(params?.x);
  const y = readNumber(params?.y);
  if (x !== null && y !== null) {
    return { agentId, x, y };
  }

  const target = resolveTargetId(params);
  if (!target) {
    return null;
  }
  return { agentId, target };
}

function findAgentByIdentifier(
  identifier: string,
  agents: Array<{ id: string; name: string }>,
): { id: string; name: string } | null {
  const normalized = identifier.toLowerCase();
  for (const agent of agents) {
    if (agent.id.toLowerCase() === normalized) {
      return agent;
    }
    if (agent.name.toLowerCase() === normalized) {
      return agent;
    }
  }
  return null;
}

function readString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function readEmoteValue(params?: ActionParameters): string | null {
  if (!params || typeof params !== "object") {
    return null;
  }
  const paramRecord = params as Record<string, unknown>;
  return (
    readString(paramRecord.emoji) ??
    readString(paramRecord.emote) ??
    readString(paramRecord.text) ??
    null
  );
}

function resolveTargetId(params?: ActionParameters): string | null {
  const direct = readString(params?.target ?? params?.name ?? params?.id);
  if (direct) {
    return direct;
  }
  const target = params?.target;
  if (target && typeof target === "object") {
    const targetRecord = target as Record<string, unknown>;
    return readTargetFromRecord(targetRecord);
  }
  if (params && typeof params === "object") {
    const paramsRecord = params as Record<string, unknown>;
    const nested =
      paramsRecord.MOVE ?? paramsRecord.move ?? paramsRecord.target;
    if (nested && typeof nested === "object") {
      const nestedRecord = nested as Record<string, unknown>;
      return readTargetFromRecord(nestedRecord);
    }
  }
  return null;
}

function readTargetFromRecord(record: Record<string, unknown>): string | null {
  return (
    readString(record.target) ??
    readString(record.value) ??
    readString(record.text) ??
    readString(record.id) ??
    readString(record.name) ??
    readString(record.label) ??
    null
  );
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
