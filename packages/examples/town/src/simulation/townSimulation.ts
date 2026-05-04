import { TOWN_AGENTS } from "../../shared/agents";
import type {
  TownAgent,
  TownAgentStatus,
  TownMessage,
  TownObjective,
  TownObjectiveStatus,
  TownState,
  Vector2,
} from "../../shared/types";
import {
  DEFAULT_AUDIO_RANGE_TILES,
  DEFAULT_VISION_RANGE_TILES,
} from "../../shared/types";
import { defaultWorldMap, isWalkableTile } from "../../shared/worldMap";
import type { ModelSettings } from "../runtime/modelSettings";
import {
  requestAgentChatDecision,
  requestAgentGameDecision,
  requestAgentMoveDecision,
  sendProximityNotice,
} from "./elizaTownRuntime";
import {
  advanceMafiaPhase,
  buildMafiaGameViewForAgent,
  getNightActionStatus,
  getVoteStatus,
  type MafiaGameState,
  type MafiaGameUpdate,
  type MafiaGameView,
  type MafiaNightAction,
  pauseMafiaGame,
  resetMafiaGame,
  startMafiaRound,
  submitMafiaNightAction,
  submitMafiaVote,
  syncMafiaGameState,
} from "./mafiaGame";

type AgentMeta = {
  nextDecisionAt: number;
  statusUntil: number;
  lastSpokeAt: number;
  lastMovedAt: number;
  moveStartAt: number | null;
  moveFrom: Vector2 | null;
  moveTo: Vector2 | null;
  nextGameDecisionAt: number;
  nextChatAt: number;
  path: Vector2[];
  pendingNavigation: Promise<NavigationPlan | null> | null;
  nearbyAgentIds: string[];
  navigationToken: number;
  goal?: AgentGoal;
  hasAiControl?: boolean;
  nextWanderAt?: number;
};

type AgentGoal =
  | {
      type: "person";
      label: string;
      position: Vector2;
    }
  | {
      type: "poi";
      label: string;
      position: Vector2;
    }
  | {
      type: "coordinate";
      label: string;
      position: Vector2;
    };

export type PointOfInterest = {
  id: string;
  name: string;
  description: string;
  position: Vector2;
  symbol: string;
  emoji: string;
};

type NavigationPlan = {
  path: Vector2[];
  goal: AgentGoal;
};

type MoveTargetKind = "agent" | "poi" | "coordinate";

export type MoveRequest = {
  agentId: string;
  target?: string;
  x?: number;
  y?: number;
};

export type MoveResult = {
  success: boolean;
  message: string;
  target?: {
    label: string;
    position: Vector2;
    type: "agent" | "poi" | "coordinate";
    id?: string;
  };
};

function toGoalType(type: MoveTargetKind): AgentGoal["type"] {
  return type === "agent" ? "person" : type;
}

const TICK_INTERVAL_MS = 5000;
const DECISION_JITTER_MS = 0;
const STATUS_DISPLAY_MS = 900;
const MOVE_DURATION_MS = 300;
const MAX_DECISIONS_PER_TICK = 3;
const MAX_GAME_DECISIONS_PER_TICK = 4;
const MAX_CHAT_PER_TICK = 2;
const BUBBLE_DURATION_MS = 10_000;
const EMOTE_DURATION_MS = 5000;
const GAME_DECISION_INTERVAL_MS = 8000;
const CHAT_COOLDOWN_MS = 12_000;
const OBJECTIVES_PER_AGENT = 2;
const OBJECTIVE_COMPLETE_RADIUS_TILES = 1;
const PROXIMITY_DISTANCE_TILES = 2;

const POINTS_OF_INTEREST: PointOfInterest[] = buildPointsOfInterest();
const DEBUG_TOWN = true;

type ObjectiveTemplate = {
  id: string;
  title: string;
  description: string;
  poiId: string;
};

const OBJECTIVE_TEMPLATES: ObjectiveTemplate[] = [
  {
    id: "gather-firewood",
    title: "Gather firewood",
    description: "Collect a fresh bundle of firewood at the Camp.",
    poiId: "camp",
  },
  {
    id: "fetch-water",
    title: "Fetch water",
    description: "Fill a water bucket at the Waterfall.",
    poiId: "waterfall",
  },
  {
    id: "market-run",
    title: "Market run",
    description: "Check the stalls and pick up supplies at the Market.",
    poiId: "market",
  },
  {
    id: "bridge-check",
    title: "Bridge check",
    description: "Inspect the Bridge and report anything unusual.",
    poiId: "bridge",
  },
  {
    id: "windmill-check",
    title: "Windmill check",
    description: "Make sure the East Windmill is running smoothly.",
    poiId: "windmill-east",
  },
  {
    id: "town-square",
    title: "Town square update",
    description: "Share a quick update from the Town Square.",
    poiId: "town-square",
  },
];

class NavigationSystem {
  async requestPath(
    start: Vector2,
    goal: AgentGoal,
    occupiedTiles: Set<string>,
  ): Promise<NavigationPlan | null> {
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
    const target = findNearestAvailable(goal.position, occupiedTiles);
    if (!target) {
      return null;
    }
    const path = findPath(start, target, occupiedTiles);
    if (!path || path.length === 0) {
      return null;
    }
    return {
      path,
      goal: { ...goal, position: target },
    };
  }
}

export type TownSimulationSnapshot = {
  version: 1;
  state: TownState;
  messageCounter: number;
  meta: Record<string, AgentMeta>;
  gameState?: MafiaGameState;
};

export class TownSimulation {
  private state: TownState;
  private meta: Record<string, AgentMeta>;
  private messageCounter: number;
  private walkableTiles: Vector2[];
  private navigator: NavigationSystem;
  private settingsProvider: () => ModelSettings;
  private gameState: MafiaGameState;

  constructor(
    settingsProvider: () => ModelSettings,
    snapshot?: TownSimulationSnapshot | null,
  ) {
    this.settingsProvider = settingsProvider;
    this.walkableTiles = buildWalkableTiles();
    this.navigator = new NavigationSystem();
    const initialState = snapshot?.state ?? {
      now: Date.now(),
      agents: createInitialAgents(this.walkableTiles),
      messages: [],
      objectives: [],
    };

    const mergedAgents = mergeAgents(this.walkableTiles, initialState.agents);
    const agentIds = mergedAgents.map((agent) => agent.id);
    this.gameState = syncMafiaGameState(snapshot?.gameState ?? null, agentIds);

    this.state = {
      now: initialState.now ?? Date.now(),
      agents: mergedAgents,
      messages: initialState.messages ?? [],
      objectives:
        initialState.objectives ??
        buildObjectives(agentIds, Math.max(1, this.gameState.round)),
    };
    this.meta = snapshot?.meta ?? {};
    this.messageCounter = snapshot?.messageCounter ?? 0;
    const now = Date.now();
    for (const agent of this.state.agents) {
      const existing = this.meta[agent.id];
      if (!existing) {
        this.meta[agent.id] = {
          nextDecisionAt: now + randomJitter(),
          statusUntil: 0,
          lastSpokeAt: 0,
          lastMovedAt: 0,
          moveStartAt: null,
          moveFrom: null,
          moveTo: null,
          nextGameDecisionAt: now + randomJitter(),
          nextChatAt: now + randomJitter(),
          path: [],
          pendingNavigation: null,
          nearbyAgentIds: [],
          navigationToken: 0,
          hasAiControl: false,
          nextWanderAt: now + Math.random() * 2000,
        };
      } else {
        if (!Array.isArray(existing.path)) {
          existing.path = [];
        }
        existing.pendingNavigation = null;
        existing.moveStartAt = existing.moveStartAt ?? null;
        existing.moveFrom = existing.moveFrom ?? null;
        existing.moveTo = existing.moveTo ?? null;
        existing.nextDecisionAt =
          existing.nextDecisionAt ?? now + randomJitter();
        existing.nextGameDecisionAt =
          existing.nextGameDecisionAt ?? now + randomJitter();
        existing.nextChatAt = existing.nextChatAt ?? now + randomJitter();
        existing.statusUntil = existing.statusUntil ?? 0;
        existing.lastSpokeAt = existing.lastSpokeAt ?? 0;
        existing.lastMovedAt = existing.lastMovedAt ?? 0;
        existing.nearbyAgentIds = Array.isArray(existing.nearbyAgentIds)
          ? existing.nearbyAgentIds
          : [];
        existing.navigationToken = existing.navigationToken ?? 0;
        existing.hasAiControl = existing.hasAiControl ?? false;
        existing.nextWanderAt =
          existing.nextWanderAt ?? now + Math.random() * 2000;
      }
    }

    if (!snapshot) {
      this.seedInitialDestinations(now);
    }
  }

  getTickIntervalMs(): number {
    return TICK_INTERVAL_MS;
  }

  getState(): TownState {
    return this.state;
  }

  getPointsOfInterest(): PointOfInterest[] {
    return POINTS_OF_INTEREST;
  }

  getGameState(): MafiaGameState {
    return this.gameState;
  }

  getGameViewForAgent(agentId: string): MafiaGameView {
    return buildMafiaGameViewForAgent(this.gameState, agentId);
  }

  queueMove(request: MoveRequest, isAiDriven = true): MoveResult {
    const agent = this.state.agents.find(
      (entry) => entry.id === request.agentId,
    );
    if (!agent) {
      return { success: false, message: "Agent not found." };
    }
    const meta = this.meta[agent.id];
    if (!meta) {
      return { success: false, message: "Agent metadata not initialized." };
    }
    const now = Date.now();
    if (meta.pendingNavigation || meta.path.length > 0) {
      meta.nextDecisionAt = now + TICK_INTERVAL_MS + randomJitter();
      return { success: false, message: "Agent is already moving." };
    }
    if (isAiDriven) {
      meta.hasAiControl = true;
    }

    const target = resolveMoveTarget(
      request,
      this.state.agents,
      POINTS_OF_INTEREST,
    );
    if (!target) {
      return { success: false, message: "Unable to resolve move target." };
    }

    const occupiedTiles = buildOccupiedTiles(this.state.agents, agent.id);
    const availableTarget = findNearestAvailable(
      target.position,
      occupiedTiles,
    );
    if (!availableTarget) {
      return { success: false, message: "No available tile near the target." };
    }
    const adjustedTarget = { ...target, position: availableTarget };

    const goal: AgentGoal = {
      type: toGoalType(target.type),
      label: target.label,
      position: availableTarget,
    };
    this.queueNavigation(agent, goal, now, occupiedTiles);
    meta.nextDecisionAt = now + TICK_INTERVAL_MS + randomJitter();

    const updatedAgents: TownAgent[] = this.state.agents.map((entry) => {
      if (entry.id !== agent.id) {
        return entry;
      }
      return {
        ...entry,
        status: "thinking" as TownAgentStatus,
        lastAction: `plan route to ${target.label}`,
        lastActionExpiresAt: now + BUBBLE_DURATION_MS,
      };
    });
    this.state = {
      ...this.state,
      now,
      agents: updatedAgents,
    };

    return {
      success: true,
      message: `Moving toward ${target.label}.`,
      target: adjustedTarget,
    };
  }

  getSnapshot(): TownSimulationSnapshot {
    const metaSnapshot: Record<string, AgentMeta> = {};
    for (const [agentId, meta] of Object.entries(this.meta)) {
      metaSnapshot[agentId] = {
        ...meta,
        pendingNavigation: null,
      };
    }
    return {
      version: 1,
      state: this.state,
      messageCounter: this.messageCounter,
      meta: metaSnapshot,
      gameState: this.gameState,
    };
  }

  startGameRound(): MafiaGameUpdate {
    const update = startMafiaRound(this.gameState);
    this.gameState = update.state;
    if (update.success) {
      this.resetObjectives(Math.max(1, this.gameState.round));
    }
    return update;
  }

  pauseGame(paused: boolean): MafiaGameUpdate {
    const update = pauseMafiaGame(this.gameState, paused);
    this.gameState = update.state;
    return update;
  }

  resetGame(): MafiaGameUpdate {
    const agentIds = this.state.agents.map((agent) => agent.id);
    const update = resetMafiaGame(this.gameState, agentIds);
    this.gameState = update.state;
    if (update.success) {
      this.resetObjectives(Math.max(1, this.gameState.round));
    }
    return update;
  }

  advanceGamePhase(): MafiaGameUpdate {
    const previousRound = this.gameState.round;
    const update = advanceMafiaPhase(this.gameState);
    this.gameState = update.state;
    if (update.success && this.gameState.round !== previousRound) {
      this.resetObjectives(Math.max(1, this.gameState.round));
    }
    return update;
  }

  private resetObjectives(round: number): void {
    const agentIds = this.state.agents.map((agent) => agent.id);
    const objectives = buildObjectives(agentIds, round);
    this.state = {
      ...this.state,
      objectives,
    };
  }

  submitVote(voterId: string, target: string): MafiaGameUpdate {
    const update = submitMafiaVote(this.gameState, voterId, target);
    this.gameState = update.state;
    return update;
  }

  submitNightAction(action: MafiaNightAction): MafiaGameUpdate {
    const update = submitMafiaNightAction(this.gameState, action);
    this.gameState = update.state;
    return update;
  }

  recordMessage(params: {
    authorId: string;
    text: string;
    participants?: string[];
    createdAt?: number;
  }): TownMessage | null {
    const agent = this.state.agents.find(
      (entry) => entry.id === params.authorId,
    );
    if (!agent) {
      return null;
    }
    const now = params.createdAt ?? Date.now();
    const message = this.buildMessage(
      agent,
      params.participants ?? [agent.id],
      params.text,
      now,
    );
    const updatedAgents = this.state.agents.map((entry) => {
      if (entry.id !== agent.id) {
        return entry;
      }
      return {
        ...entry,
        status: "speaking" as TownAgentStatus,
        lastMessage: message.text,
        lastMessageExpiresAt: now + BUBBLE_DURATION_MS,
      };
    });
    const meta = this.meta[agent.id];
    if (meta) {
      meta.lastSpokeAt = now;
      meta.statusUntil = now + STATUS_DISPLAY_MS;
      meta.nextDecisionAt = now + TICK_INTERVAL_MS + randomJitter();
    }
    this.state = {
      ...this.state,
      now,
      agents: updatedAgents,
      messages: [...this.state.messages, message],
    };
    return message;
  }

  recordEmote(agentId: string, emote: string, createdAt?: number): boolean {
    const agent = this.state.agents.find((entry) => entry.id === agentId);
    if (!agent) {
      return false;
    }
    const now = createdAt ?? Date.now();
    const updatedAgents = this.state.agents.map((entry) => {
      if (entry.id !== agent.id) {
        return entry;
      }
      return {
        ...entry,
        emote,
        emoteExpiresAt: now + EMOTE_DURATION_MS,
      };
    });
    this.state = {
      ...this.state,
      now,
      agents: updatedAgents,
    };
    return true;
  }

  stopAgent(agentId: string): boolean {
    const agent = this.state.agents.find((entry) => entry.id === agentId);
    if (!agent) {
      return false;
    }
    const now = Date.now();
    const meta = this.meta[agentId];
    if (meta) {
      meta.navigationToken += 1;
      meta.pendingNavigation = null;
      meta.path = [];
      meta.goal = undefined;
      meta.moveStartAt = null;
      meta.moveFrom = null;
      meta.moveTo = null;
      meta.statusUntil = 0;
      meta.lastMovedAt = now;
    }
    const updatedAgents = this.state.agents.map((entry) => {
      if (entry.id !== agentId) {
        return entry;
      }
      return {
        ...entry,
        status: "idle" as TownAgentStatus,
        lastAction: "stop",
        lastActionExpiresAt: now + BUBBLE_DURATION_MS,
        renderPosition: entry.renderPosition ?? entry.position,
      };
    });
    this.state = {
      ...this.state,
      agents: updatedAgents,
    };
    return true;
  }

  async tick(): Promise<TownState> {
    const now = Date.now();
    logTown("info", "agents:tick", { now, count: this.state.agents.length });
    const updates = new Map<string, Partial<TownAgent>>();
    const decisionCandidates = shuffleAgents(
      this.state.agents.filter((agent) => {
        const meta = this.meta[agent.id];
        if (!meta) {
          return false;
        }
        const isBusy = meta.pendingNavigation !== null || meta.path.length > 0;
        return now >= meta.nextDecisionAt && !isBusy;
      }),
    );
    let remainingDecisions = MAX_DECISIONS_PER_TICK;

    for (const agent of decisionCandidates) {
      if (remainingDecisions <= 0) {
        break;
      }
      const meta = this.meta[agent.id];
      if (!meta) {
        continue;
      }
      try {
        await requestAgentMoveDecision(agent.id, this.settingsProvider());
        meta.statusUntil = now + STATUS_DISPLAY_MS;
      } catch {
        // Skip if the runtime is unavailable or request fails.
      }
      meta.nextDecisionAt = now + TICK_INTERVAL_MS + randomJitter();
      remainingDecisions -= 1;
    }

    const canRequestGameActions =
      this.gameState.phase === "night" || this.gameState.phase === "day";
    if (canRequestGameActions) {
      const gameCandidates = shuffleAgents(
        this.state.agents.filter((agent) => {
          const meta = this.meta[agent.id];
          if (!meta) {
            return false;
          }
          if (!this.isAgentAliveInGame(agent.id)) {
            return false;
          }
          return now >= meta.nextGameDecisionAt;
        }),
      );
      let remainingGameDecisions = MAX_GAME_DECISIONS_PER_TICK;
      for (const agent of gameCandidates) {
        if (remainingGameDecisions <= 0) {
          break;
        }
        const meta = this.meta[agent.id];
        if (!meta) {
          continue;
        }
        try {
          await requestAgentGameDecision(agent.id, this.settingsProvider());
        } catch {
          // Skip if the runtime is unavailable or request fails.
        }
        meta.nextGameDecisionAt =
          now + GAME_DECISION_INTERVAL_MS + randomJitter();
        remainingGameDecisions -= 1;
      }
    }

    await this.notifyProximityChanges();

    const chatCandidates = shuffleAgents(
      this.state.agents.filter((agent) => {
        const meta = this.meta[agent.id];
        if (!meta) {
          return false;
        }
        if (!this.isAgentAliveInGame(agent.id)) {
          return false;
        }
        if (agent.status !== "idle") {
          return false;
        }
        const isBusy = meta.pendingNavigation !== null || meta.path.length > 0;
        if (isBusy) {
          return false;
        }
        return now >= meta.nextChatAt;
      }),
    );
    let remainingChats = MAX_CHAT_PER_TICK;
    for (const agent of chatCandidates) {
      if (remainingChats <= 0) {
        break;
      }
      const meta = this.meta[agent.id];
      if (!meta) {
        continue;
      }
      try {
        await requestAgentChatDecision(agent.id, this.settingsProvider());
      } catch {
        // Skip if runtime is unavailable.
      }
      meta.nextChatAt = now + CHAT_COOLDOWN_MS + randomJitter();
      remainingChats -= 1;
    }

    this.maybeAutoAdvanceGamePhase();

    // Random wandering for agents without AI control
    for (const agent of this.state.agents) {
      const meta = this.meta[agent.id];
      if (!meta) {
        continue;
      }
      const isIdle =
        !meta.pendingNavigation && meta.path.length === 0 && !meta.hasAiControl;
      if (
        isIdle &&
        meta.nextWanderAt !== undefined &&
        now >= meta.nextWanderAt
      ) {
        this.queueRandomWander(agent, now);
      }
    }

    const baseState = this.state;
    for (const agent of baseState.agents) {
      const meta = this.meta[agent.id];
      const baseAgent = updates.get(agent.id)
        ? { ...agent, ...updates.get(agent.id) }
        : agent;
      const isStatusActive = meta.statusUntil > now;
      const isPendingNavigation = meta.pendingNavigation !== null;
      const isFollowingPath = meta.path.length > 0;

      const status = isPendingNavigation
        ? "thinking"
        : isFollowingPath
          ? "moving"
          : isStatusActive
            ? baseAgent.status
            : "idle";
      if (status !== baseAgent.status) {
        updates.set(agent.id, { status });
      }
      logTown("debug", "agent:update", {
        id: agent.id,
        name: baseAgent.name,
        status,
        reason: isPendingNavigation
          ? "navigation"
          : isFollowingPath
            ? "path"
            : isStatusActive
              ? "status"
              : "idle",
      });
    }

    const mergedAgents = baseState.agents.map((agent) => {
      const update = updates.get(agent.id);
      return update ? { ...agent, ...update } : agent;
    });
    const objectiveUpdate = updateObjectivesForAgents(
      baseState.objectives,
      mergedAgents,
    );

    this.state = {
      now,
      agents: mergedAgents,
      messages: baseState.messages,
      objectives: objectiveUpdate.objectives,
    };

    return this.state;
  }

  updateFrame(now: number): TownState {
    let changed = false;
    const updatedAgents: TownAgent[] = this.state.agents.map((agent) => {
      const meta = this.meta[agent.id];

      let lastActionExpiresAt = agent.lastActionExpiresAt;
      let lastMessageExpiresAt = agent.lastMessageExpiresAt;
      let emote = agent.emote;
      let emoteExpiresAt = agent.emoteExpiresAt;
      if (lastActionExpiresAt && lastActionExpiresAt <= now) {
        lastActionExpiresAt = null;
        changed = true;
      }
      if (lastMessageExpiresAt && lastMessageExpiresAt <= now) {
        lastMessageExpiresAt = null;
        changed = true;
      }
      if (emoteExpiresAt && emoteExpiresAt <= now) {
        emoteExpiresAt = null;
        emote = null;
        changed = true;
      }

      if (meta.pendingNavigation) {
        const renderPosition = agent.renderPosition ?? agent.position;
        if (
          agent.status !== "thinking" ||
          lastActionExpiresAt !== agent.lastActionExpiresAt ||
          lastMessageExpiresAt !== agent.lastMessageExpiresAt ||
          emoteExpiresAt !== agent.emoteExpiresAt ||
          emote !== agent.emote ||
          renderPosition !== agent.renderPosition
        ) {
          changed = true;
          return {
            ...agent,
            status: "thinking",
            lastActionExpiresAt,
            lastMessageExpiresAt,
            emote,
            emoteExpiresAt,
            renderPosition,
          };
        }
        return agent;
      }

      const moveActive =
        meta.moveStartAt !== null &&
        meta.moveFrom !== null &&
        meta.moveTo !== null;

      if (!moveActive && meta.path.length === 0) {
        const renderPosition = agent.renderPosition ?? agent.position;
        if (agent.status !== "idle" && meta.statusUntil <= now) {
          changed = true;
          return {
            ...agent,
            status: "idle",
            lastActionExpiresAt,
            lastMessageExpiresAt,
            emote,
            emoteExpiresAt,
            renderPosition,
          };
        }
        if (
          lastActionExpiresAt !== agent.lastActionExpiresAt ||
          lastMessageExpiresAt !== agent.lastMessageExpiresAt ||
          emoteExpiresAt !== agent.emoteExpiresAt ||
          emote !== agent.emote ||
          renderPosition !== agent.renderPosition
        ) {
          changed = true;
          return {
            ...agent,
            lastActionExpiresAt,
            lastMessageExpiresAt,
            emote,
            emoteExpiresAt,
            renderPosition,
          };
        }
        return agent;
      }

      if (!moveActive && meta.path.length > 0) {
        const nextStep = meta.path[0];
        if (
          !isWalkableTile(nextStep.x, nextStep.y) ||
          isTileOccupied(nextStep, this.state.agents, agent.id)
        ) {
          meta.path = [];
          meta.goal = undefined;
          meta.moveStartAt = null;
          meta.moveFrom = null;
          meta.moveTo = null;
          changed = true;
          logTown("warn", "agent:blocked", {
            id: agent.id,
            name: agent.name,
            blockedAt: nextStep,
          });
          return {
            ...agent,
            status: "idle",
            lastActionExpiresAt,
            lastMessageExpiresAt,
            emote,
            emoteExpiresAt,
            renderPosition: agent.position,
          };
        }

        const orientation = orientationForStep(agent.position, nextStep);
        const lastAction = meta.goal ? `walk to ${meta.goal.label}` : "walk";
        meta.moveStartAt = now;
        meta.moveFrom = agent.position;
        meta.moveTo = nextStep;
        meta.lastMovedAt = now;
        meta.statusUntil = now + STATUS_DISPLAY_MS;
        changed = true;
        logTown("debug", "agent:move:start", {
          id: agent.id,
          name: agent.name,
          from: agent.position,
          to: nextStep,
          remaining: meta.path.length,
        });
        return {
          ...agent,
          orientation,
          status: "moving",
          lastAction,
          lastActionExpiresAt: now + BUBBLE_DURATION_MS,
          lastMessageExpiresAt,
          emote,
          emoteExpiresAt,
          renderPosition: agent.position,
        };
      }

      if (
        moveActive &&
        meta.moveFrom &&
        meta.moveTo &&
        meta.moveStartAt !== null
      ) {
        const progress = (now - meta.moveStartAt) / MOVE_DURATION_MS;
        const t = clamp01(progress);
        const renderPosition = lerpVector(meta.moveFrom, meta.moveTo, t);
        let position = agent.position;
        if (t >= 1) {
          if (isTileOccupied(meta.moveTo, this.state.agents, agent.id)) {
            meta.path = [];
            meta.goal = undefined;
            meta.moveStartAt = null;
            meta.moveFrom = null;
            meta.moveTo = null;
            logTown("warn", "agent:blocked", {
              id: agent.id,
              name: agent.name,
              blockedAt: meta.moveTo,
            });
            return {
              ...agent,
              status: "idle",
              lastActionExpiresAt,
              lastMessageExpiresAt,
              emote,
              emoteExpiresAt,
              renderPosition: agent.position,
            };
          }
          position = meta.moveTo;
          meta.path = meta.path.slice(1);
          meta.moveStartAt = null;
          meta.moveFrom = null;
          meta.moveTo = null;
          if (meta.path.length === 0) {
            meta.goal = undefined;
          }
          logTown("debug", "agent:move:complete", {
            id: agent.id,
            name: agent.name,
            to: position,
            remaining: meta.path.length,
          });
        }
        changed = true;
        return {
          ...agent,
          position,
          status: "moving",
          renderPosition,
          lastActionExpiresAt,
          lastMessageExpiresAt,
          emote,
          emoteExpiresAt,
        };
      }

      return agent;
    });

    if (!changed) {
      return this.state;
    }

    this.state = {
      ...this.state,
      now,
      agents: updatedAgents,
    };

    return this.state;
  }

  private queueNavigation(
    agent: TownAgent,
    goal: AgentGoal,
    now: number,
    occupiedTiles: Set<string>,
  ): void {
    const meta = this.meta[agent.id];
    if (meta.pendingNavigation) {
      return;
    }
    const token = meta.navigationToken + 1;
    meta.navigationToken = token;
    meta.path = [];
    meta.goal = goal;
    logTown("info", "agent:navigation:request", {
      id: agent.id,
      name: agent.name,
      goal: goal.label,
      position: agent.position,
    });
    meta.pendingNavigation = this.navigator
      .requestPath(agent.position, goal, occupiedTiles)
      .then((plan) => {
        if (meta.navigationToken !== token) {
          return null;
        }
        if (!plan) {
          meta.pendingNavigation = null;
          meta.goal = undefined;
          logTown("warn", "agent:navigation:failed", {
            id: agent.id,
            name: agent.name,
            goal: goal.label,
          });
          return null;
        }
        meta.path = plan.path;
        meta.goal = plan.goal;
        meta.pendingNavigation = null;
        logTown("info", "agent:navigation:ready", {
          id: agent.id,
          name: agent.name,
          goal: plan.goal.label,
          steps: plan.path.length,
        });
        return plan;
      });
    meta.statusUntil = now + STATUS_DISPLAY_MS;
  }

  private buildMessage(
    agent: TownAgent,
    participants: string[],
    text: string,
    createdAt: number,
  ): TownMessage {
    this.messageCounter += 1;
    return {
      id: `msg-${this.messageCounter}`,
      conversationId: null,
      authorId: agent.id,
      authorName: agent.name,
      participants,
      text,
      createdAt,
    };
  }

  private isAgentAliveInGame(agentId: string): boolean {
    const player = this.gameState.players.find(
      (entry) => entry.agentId === agentId,
    );
    return player ? player.alive : true;
  }

  private async notifyProximityChanges(): Promise<void> {
    const agents = this.state.agents;
    const notifications: Array<Promise<void>> = [];
    for (const agent of agents) {
      const meta = this.meta[agent.id];
      if (!meta) {
        continue;
      }
      const currentNearby = new Set<string>();
      for (const other of agents) {
        if (other.id === agent.id) {
          continue;
        }
        const distance = distanceTiles(agent.position, other.position);
        if (distance <= PROXIMITY_DISTANCE_TILES) {
          currentNearby.add(other.id);
          if (!meta.nearbyAgentIds.includes(other.id)) {
            notifications.push(
              sendProximityNotice(
                agent.id,
                other.name,
                this.settingsProvider(),
              ),
            );
          }
        }
      }
      meta.nearbyAgentIds = Array.from(currentNearby);
    }
    if (notifications.length > 0) {
      await Promise.all(notifications);
    }
  }

  private queueRandomWander(agent: TownAgent, now: number): void {
    const meta = this.meta[agent.id];
    if (!meta || meta.pendingNavigation || meta.path.length > 0) {
      return;
    }
    const occupiedTiles = buildOccupiedTiles(this.state.agents, agent.id);
    const nearbyTiles = this.walkableTiles.filter((tile) => {
      const dx = Math.abs(tile.x - agent.position.x);
      const dy = Math.abs(tile.y - agent.position.y);
      const dist = Math.max(dx, dy);
      return (
        dist >= 2 && dist <= 6 && !occupiedTiles.has(`${tile.x},${tile.y}`)
      );
    });
    if (nearbyTiles.length === 0) {
      meta.nextWanderAt = now + 2000 + Math.random() * 3000;
      return;
    }
    const target = nearbyTiles[Math.floor(Math.random() * nearbyTiles.length)];
    if (!target) {
      meta.nextWanderAt = now + 2000 + Math.random() * 3000;
      return;
    }
    const goal: AgentGoal = {
      type: "coordinate",
      label: "wandering",
      position: target,
    };
    this.queueNavigation(agent, goal, now, occupiedTiles);
    meta.nextWanderAt = now + 4000 + Math.random() * 6000;
  }

  private seedInitialDestinations(now: number): void {
    const reservedTargets = new Set<string>();
    const poiCandidates = shuffleList(POINTS_OF_INTEREST);
    for (const agent of this.state.agents) {
      const meta = this.meta[agent.id];
      if (!meta || meta.pendingNavigation || meta.path.length > 0) {
        continue;
      }
      const occupiedTiles = buildOccupiedTiles(this.state.agents, agent.id);
      const target = this.pickInitialTarget(
        agent,
        occupiedTiles,
        reservedTargets,
        poiCandidates,
      );
      if (!target) {
        continue;
      }
      const path = findPath(agent.position, target.position, occupiedTiles);
      if (!path || path.length === 0) {
        continue;
      }
      meta.path = path;
      meta.goal = {
        type: toGoalType(target.type),
        label: target.label,
        position: target.position,
      };
      meta.statusUntil = now + STATUS_DISPLAY_MS;
      reservedTargets.add(coordKey(target.position));
      logTown("debug", "agent:seed:destination", {
        id: agent.id,
        name: agent.name,
        goal: target.label,
        steps: path.length,
      });
    }
  }

  private pickInitialTarget(
    agent: TownAgent,
    occupiedTiles: Set<string>,
    reservedTargets: Set<string>,
    poiCandidates: PointOfInterest[],
  ): { type: MoveTargetKind; label: string; position: Vector2 } | null {
    const minDistance = 2;
    for (const poi of poiCandidates) {
      const distance = Math.max(
        Math.abs(poi.position.x - agent.position.x),
        Math.abs(poi.position.y - agent.position.y),
      );
      if (distance < minDistance) {
        continue;
      }
      const availableTarget = findNearestAvailable(poi.position, occupiedTiles);
      if (!availableTarget) {
        continue;
      }
      const key = coordKey(availableTarget);
      if (reservedTargets.has(key)) {
        continue;
      }
      return { type: "poi", label: poi.name, position: availableTarget };
    }

    const attempts = Math.min(20, this.walkableTiles.length);
    for (let i = 0; i < attempts; i += 1) {
      const candidate =
        this.walkableTiles[
          Math.floor(Math.random() * this.walkableTiles.length)
        ];
      if (!candidate) {
        continue;
      }
      const distance = Math.max(
        Math.abs(candidate.x - agent.position.x),
        Math.abs(candidate.y - agent.position.y),
      );
      if (distance < minDistance || distance > 8) {
        continue;
      }
      if (!isTileAvailable(candidate, occupiedTiles)) {
        continue;
      }
      const key = coordKey(candidate);
      if (reservedTargets.has(key)) {
        continue;
      }
      return {
        type: "coordinate",
        label: `${candidate.x},${candidate.y}`,
        position: candidate,
      };
    }

    return null;
  }

  private maybeAutoAdvanceGamePhase(): void {
    if (this.gameState.isPaused || this.gameState.phase === "ended") {
      return;
    }
    if (this.gameState.phase === "night") {
      const status = getNightActionStatus(this.gameState);
      if (status.ready) {
        const update = advanceMafiaPhase(this.gameState);
        this.gameState = update.state;
      }
      return;
    }
    if (this.gameState.phase === "day") {
      const voteStatus = getVoteStatus(this.gameState);
      if (voteStatus.ready) {
        const update = advanceMafiaPhase(this.gameState);
        this.gameState = update.state;
      }
    }
  }
}

function randomJitter(): number {
  return Math.floor(Math.random() * DECISION_JITTER_MS);
}

function clamp01(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function lerpVector(from: Vector2, to: Vector2, t: number): Vector2 {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  };
}

function shuffleList<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const current = shuffled[i];
    shuffled[i] = shuffled[j] ?? shuffled[i];
    shuffled[j] = current;
  }
  return shuffled;
}

function shuffleAgents(agents: TownAgent[]): TownAgent[] {
  return shuffleList(agents);
}

function updateObjectivesForAgents(
  objectives: TownObjective[],
  agents: TownAgent[],
): { objectives: TownObjective[]; changed: boolean } {
  if (objectives.length === 0) {
    return { objectives, changed: false };
  }
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  let changed = false;
  const updated = objectives.map((objective) => {
    if (objective.status === "completed") {
      return objective;
    }
    let completedBy = objective.completedBy;
    for (const agentId of objective.assignedAgentIds) {
      if (completedBy.includes(agentId)) {
        continue;
      }
      const agent = agentsById.get(agentId);
      if (!agent) {
        continue;
      }
      if (
        distanceTiles(agent.position, objective.location) >
        OBJECTIVE_COMPLETE_RADIUS_TILES
      ) {
        continue;
      }
      if (completedBy === objective.completedBy) {
        completedBy = [...objective.completedBy];
      }
      completedBy.push(agentId);
      changed = true;
    }
    if (completedBy === objective.completedBy) {
      return objective;
    }
    const status: TownObjectiveStatus =
      completedBy.length >= objective.assignedAgentIds.length
        ? "completed"
        : objective.status;
    return {
      ...objective,
      completedBy,
      status,
    };
  });
  return { objectives: changed ? updated : objectives, changed };
}

function buildWalkableTiles(): Vector2[] {
  const tiles: Vector2[] = [];
  for (let x = 0; x < defaultWorldMap.width; x += 1) {
    for (let y = 0; y < defaultWorldMap.height; y += 1) {
      if (isWalkableTile(x, y)) {
        tiles.push({ x, y });
      }
    }
  }
  return tiles;
}

function createInitialAgents(walkableTiles: Vector2[]): TownAgent[] {
  if (walkableTiles.length === 0) {
    throw new Error("No walkable tiles available for town initialization.");
  }

  const shuffledTiles = [...walkableTiles];
  for (let i = shuffledTiles.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = shuffledTiles[i];
    shuffledTiles[i] = shuffledTiles[j];
    shuffledTiles[j] = temp;
  }

  return TOWN_AGENTS.map((agent, index) => {
    const tile = shuffledTiles[index % shuffledTiles.length];
    return {
      id: agent.id,
      name: agent.name,
      characterId: agent.characterId,
      position: { x: tile.x, y: tile.y },
      renderPosition: { x: tile.x, y: tile.y },
      visionRangeTiles: DEFAULT_VISION_RANGE_TILES,
      audioRangeTiles: DEFAULT_AUDIO_RANGE_TILES,
      orientation: 90,
      status: "idle",
      lastAction: null,
      lastActionExpiresAt: null,
      lastMessage: null,
      lastMessageExpiresAt: null,
      emote: null,
      emoteExpiresAt: null,
    };
  });
}

function mergeAgents(
  walkableTiles: Vector2[],
  agents: TownAgent[],
): TownAgent[] {
  const defaults = createInitialAgents(walkableTiles);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return defaults.map((base) => {
    const existing = byId.get(base.id);
    if (!existing) {
      return base;
    }
    return {
      ...base,
      position: existing.position,
      renderPosition: existing.renderPosition ?? existing.position,
      visionRangeTiles: existing.visionRangeTiles ?? base.visionRangeTiles,
      audioRangeTiles: existing.audioRangeTiles ?? base.audioRangeTiles,
      orientation: existing.orientation,
      status: existing.status,
      lastAction: existing.lastAction,
      lastActionExpiresAt: existing.lastActionExpiresAt ?? null,
      lastMessage: existing.lastMessage,
      lastMessageExpiresAt: existing.lastMessageExpiresAt ?? null,
      emote: existing.emote ?? null,
      emoteExpiresAt: existing.emoteExpiresAt ?? null,
    };
  });
}

type ResolvedMoveTarget = {
  label: string;
  position: Vector2;
  type: MoveTargetKind;
  id?: string;
};

function resolveMoveTarget(
  request: MoveRequest,
  agents: TownAgent[],
  pointsOfInterest: PointOfInterest[],
): ResolvedMoveTarget | null {
  if (Number.isFinite(request.x) && Number.isFinite(request.y)) {
    const x = clampCoordinate(request.x ?? 0, defaultWorldMap.width);
    const y = clampCoordinate(request.y ?? 0, defaultWorldMap.height);
    return {
      label: `${x},${y}`,
      position: { x, y },
      type: "coordinate",
    };
  }

  if (
    typeof request.target !== "string" ||
    request.target.trim().length === 0
  ) {
    return null;
  }
  const target = request.target.trim();
  const coordinate = parseTargetCoordinate(target);
  if (coordinate) {
    const x = clampCoordinate(coordinate.x, defaultWorldMap.width);
    const y = clampCoordinate(coordinate.y, defaultWorldMap.height);
    return {
      label: `${x},${y}`,
      position: { x, y },
      type: "coordinate",
    };
  }
  const poi = findPoiByIdentifier(target, pointsOfInterest);
  if (poi) {
    return {
      label: poi.name,
      position: poi.position,
      type: "poi",
      id: poi.id,
    };
  }
  const agent = findAgentByIdentifier(target, agents);
  if (agent) {
    return {
      label: agent.name,
      position: agent.position,
      type: "agent",
      id: agent.id,
    };
  }
  const partialAgent = findAgentByPartialName(target, agents);
  if (partialAgent) {
    return {
      label: partialAgent.name,
      position: partialAgent.position,
      type: "agent",
      id: partialAgent.id,
    };
  }
  return null;
}

function findAgentByIdentifier(
  identifier: string,
  agents: TownAgent[],
): TownAgent | null {
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

function findAgentByPartialName(
  query: string,
  agents: TownAgent[],
): TownAgent | null {
  const normalized = query.toLowerCase();
  if (normalized.length === 0) {
    return null;
  }
  for (const agent of agents) {
    if (agent.name.toLowerCase().includes(normalized)) {
      return agent;
    }
  }
  return null;
}

function findPoiByIdentifier(
  identifier: string,
  pointsOfInterest: PointOfInterest[],
): PointOfInterest | null {
  const normalized = identifier.toLowerCase();
  for (const poi of pointsOfInterest) {
    if (poi.id.toLowerCase() === normalized) {
      return poi;
    }
    if (poi.name.toLowerCase() === normalized) {
      return poi;
    }
  }
  return null;
}

function clampCoordinate(value: number, max: number): number {
  const limit = Math.max(0, max - 1);
  return Math.min(Math.max(0, Math.round(value)), limit);
}

function distanceTiles(a: Vector2, b: Vector2): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return Math.max(dx, dy);
}

function parseTargetCoordinate(target: string): Vector2 | null {
  const match = target.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (match) {
    const x = Number.parseFloat(match[1] ?? "");
    const y = Number.parseFloat(match[2] ?? "");
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }
  const parts = target.trim().split(/\s+/);
  if (parts.length === 2) {
    const x = Number.parseFloat(parts[0] ?? "");
    const y = Number.parseFloat(parts[1] ?? "");
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }
  return null;
}

function buildOccupiedTiles(
  agents: TownAgent[],
  ignoreId: string,
): Set<string> {
  const occupied = new Set<string>();
  for (const agent of agents) {
    if (agent.id === ignoreId) {
      continue;
    }
    occupied.add(coordKey(agent.position));
  }
  return occupied;
}

function isTileAvailable(
  position: Vector2,
  occupiedTiles: Set<string>,
): boolean {
  return (
    isWalkableTile(position.x, position.y) &&
    !occupiedTiles.has(coordKey(position))
  );
}

function isTileOccupied(
  position: Vector2,
  agents: TownAgent[],
  ignoreId: string,
): boolean {
  for (const agent of agents) {
    if (agent.id === ignoreId) {
      continue;
    }
    if (agent.position.x === position.x && agent.position.y === position.y) {
      return true;
    }
  }
  return false;
}

function findNearestAvailable(
  position: Vector2,
  occupiedTiles: Set<string>,
): Vector2 | null {
  const queue: Vector2[] = [position];
  const visited = new Set<string>([coordKey(position)]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    if (isTileAvailable(current, occupiedTiles)) {
      return current;
    }
    for (const neighbor of getNeighbors(current)) {
      const key = coordKey(neighbor);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      queue.push(neighbor);
    }
  }
  return null;
}

function findPath(
  start: Vector2,
  goal: Vector2,
  occupiedTiles: Set<string>,
): Vector2[] | null {
  if (start.x === goal.x && start.y === goal.y) {
    return [];
  }
  const queue: Vector2[] = [start];
  const visited = new Set<string>([coordKey(start)]);
  const cameFrom = new Map<string, Vector2>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    if (current.x === goal.x && current.y === goal.y) {
      return reconstructPath(start, goal, cameFrom);
    }
    for (const neighbor of getNeighbors(current)) {
      if (!isTileAvailable(neighbor, occupiedTiles)) {
        continue;
      }
      const key = coordKey(neighbor);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      cameFrom.set(key, current);
      queue.push(neighbor);
    }
  }
  return null;
}

function reconstructPath(
  start: Vector2,
  goal: Vector2,
  cameFrom: Map<string, Vector2>,
): Vector2[] {
  const path: Vector2[] = [];
  let current: Vector2 = goal;
  while (!(current.x === start.x && current.y === start.y)) {
    path.push(current);
    const prev = cameFrom.get(coordKey(current));
    if (!prev) {
      break;
    }
    current = prev;
  }
  return path.reverse();
}

function getNeighbors(position: Vector2): Vector2[] {
  return [
    { x: position.x + 1, y: position.y },
    { x: position.x - 1, y: position.y },
    { x: position.x, y: position.y + 1 },
    { x: position.x, y: position.y - 1 },
  ].filter((neighbor) => isInBounds(neighbor));
}

function isInBounds(position: Vector2): boolean {
  return (
    position.x >= 0 &&
    position.y >= 0 &&
    position.x < defaultWorldMap.width &&
    position.y < defaultWorldMap.height
  );
}

function coordKey(position: Vector2): string {
  return `${position.x},${position.y}`;
}

function orientationForStep(from: Vector2, to: Vector2): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 1 && dy === 0) {
    return 0;
  }
  if (dx === -1 && dy === 0) {
    return 180;
  }
  if (dx === 0 && dy === 1) {
    return 90;
  }
  if (dx === 0 && dy === -1) {
    return 270;
  }
  return from.x === to.x && from.y === to.y ? 90 : 0;
}

function buildPointsOfInterest(): PointOfInterest[] {
  const width = defaultWorldMap.width;
  const height = defaultWorldMap.height;
  const used = new Set<string>();
  const tileFromPixels = (x: number, y: number): Vector2 => ({
    x: Math.round(x / defaultWorldMap.tileDim),
    y: Math.round(y / defaultWorldMap.tileDim),
  });
  const firstSpriteTile = (sheet: string): Vector2 | null => {
    const sprite = defaultWorldMap.animatedSprites.find(
      (entry) => entry.sheet === sheet,
    );
    return sprite ? tileFromPixels(sprite.x, sprite.y) : null;
  };
  const bridgeTileIds = new Set<number>([
    11, 12, 13, 14, 15, 56, 57, 58, 59, 60, 101, 102, 103, 104, 105, 146, 147,
    148, 149, 150, 191, 192, 193, 194, 195, 236, 237, 238, 239, 240,
  ]);
  const bridgeClusters = findTileClusters(
    defaultWorldMap.bgTiles,
    bridgeTileIds,
  );
  const bridgeCluster = bridgeClusters.sort((a, b) => b.size - a.size)[0];
  const windmillTiles = Array.from(
    new Map(
      defaultWorldMap.animatedSprites
        .filter((entry) => entry.sheet === "windmill.json")
        .map((entry) => {
          const tile = tileFromPixels(entry.x, entry.y);
          return [coordKey(tile), tile] as const;
        }),
    ).values(),
  ).sort((a, b) => a.x - b.x);

  const candidates: Array<
    Omit<PointOfInterest, "position"> & { position: Vector2 | null }
  > = [
    {
      id: "town-square",
      name: "Town Square",
      description: "The town crossroads where paths intersect.",
      position: { x: Math.floor(width * 0.5), y: Math.floor(height * 0.5) },
      symbol: "T",
      emoji: "🏛️",
    },
    {
      id: "market",
      name: "Market",
      description: "A bustling market with stalls and chatter.",
      position: { x: Math.floor(width * 0.25), y: Math.floor(height * 0.35) },
      symbol: "M",
      emoji: "🛒",
    },
    {
      id: "bridge",
      name: "Bridge",
      description: "A wooden bridge that spans the river.",
      position: bridgeCluster?.center ?? null,
      symbol: "B",
      emoji: "🌉",
    },
    {
      id: "camp",
      name: "Camp",
      description: "A cozy campfire gathering spot.",
      position: firstSpriteTile("campfire.json"),
      symbol: "C",
      emoji: "🏕️",
    },
    {
      id: "waterfall",
      name: "Waterfall",
      description: "A cascading waterfall beside the path.",
      position: firstSpriteTile("gentlewaterfall.json"),
      symbol: "F",
      emoji: "🌊",
    },
    {
      id: "windmill-east",
      name: "East Windmill",
      description: "A tall windmill overlooking the fields.",
      position: windmillTiles[2] ?? null,
      symbol: "E",
      emoji: "🌬️",
    },
    {
      id: "windmill-south",
      name: "South Windmill",
      description: "A windmill near the southern farms.",
      position: windmillTiles[1] ?? null,
      symbol: "V",
      emoji: "🌬️",
    },
    {
      id: "windmill-west",
      name: "West Windmill",
      description: "A windmill standing in the western breeze.",
      position: windmillTiles[0] ?? null,
      symbol: "W",
      emoji: "🌬️",
    },
  ];

  return candidates
    .map((poi) => {
      if (!poi.position) {
        return null;
      }
      const walkable = findNearestWalkable(poi.position, used);
      if (!walkable) {
        return null;
      }
      used.add(coordKey(walkable));
      return { ...poi, position: walkable };
    })
    .filter((poi): poi is PointOfInterest => poi !== null);
}

function buildObjectives(agentIds: string[], round: number): TownObjective[] {
  if (agentIds.length === 0) {
    return [];
  }
  const templates = shuffleList(OBJECTIVE_TEMPLATES);
  const objectives: TownObjective[] = [];
  let templateIndex = 0;
  for (const agentId of agentIds) {
    for (let i = 0; i < OBJECTIVES_PER_AGENT; i += 1) {
      const template = templates[templateIndex % templates.length];
      templateIndex += 1;
      if (!template) {
        continue;
      }
      const poi = POINTS_OF_INTEREST.find(
        (entry) => entry.id === template.poiId,
      );
      if (!poi) {
        continue;
      }
      objectives.push({
        id: `obj-${round}-${agentId}-${template.id}-${i}`,
        title: template.title,
        description: template.description,
        round,
        location: poi.position,
        poiId: poi.id,
        assignedAgentIds: [agentId],
        completedBy: [],
        status: "pending",
      });
    }
  }
  return objectives;
}

function findNearestWalkable(
  position: Vector2,
  used?: Set<string>,
): Vector2 | null {
  if (isWalkableTile(position.x, position.y)) {
    if (!used || !used.has(coordKey(position))) {
      return position;
    }
  }
  const queue: Vector2[] = [position];
  const visited = new Set<string>([coordKey(position)]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    for (const neighbor of getNeighbors(current)) {
      const key = coordKey(neighbor);
      if (visited.has(key)) {
        continue;
      }
      if (isWalkableTile(neighbor.x, neighbor.y) && (!used || !used.has(key))) {
        return neighbor;
      }
      visited.add(key);
      queue.push(neighbor);
    }
  }
  return null;
}

type TileCluster = {
  center: Vector2;
  size: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

function findTileClusters(
  layers: number[][][],
  tileIds: Set<number>,
): TileCluster[] {
  const positions = new Set<string>();
  for (const layer of layers) {
    for (let x = 0; x < layer.length; x += 1) {
      for (let y = 0; y < layer[x].length; y += 1) {
        if (tileIds.has(layer[x][y])) {
          positions.add(coordKey({ x, y }));
        }
      }
    }
  }

  const visited = new Set<string>();
  const clusters: TileCluster[] = [];
  const directions = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];

  for (const key of positions) {
    if (visited.has(key)) {
      continue;
    }
    const queue = [key];
    visited.add(key);
    const tiles: Vector2[] = [];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      const [xString, yString] = current.split(",");
      const x = Number.parseInt(xString ?? "0", 10);
      const y = Number.parseInt(yString ?? "0", 10);
      tiles.push({ x, y });
      for (const { dx, dy } of directions) {
        const neighbor = coordKey({ x: x + dx, y: y + dy });
        if (positions.has(neighbor) && !visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let sumX = 0;
    let sumY = 0;
    for (const tile of tiles) {
      minX = Math.min(minX, tile.x);
      maxX = Math.max(maxX, tile.x);
      minY = Math.min(minY, tile.y);
      maxY = Math.max(maxY, tile.y);
      sumX += tile.x;
      sumY += tile.y;
    }
    const center = {
      x: Math.round(sumX / tiles.length),
      y: Math.round(sumY / tiles.length),
    };
    clusters.push({
      center,
      size: tiles.length,
      minX,
      maxX,
      minY,
      maxY,
    });
  }

  return clusters;
}

function logTown(
  level: "debug" | "info" | "warn",
  event: string,
  data: Record<string, number | string | boolean | Vector2 | null>,
): void {
  if (!DEBUG_TOWN) {
    return;
  }
  const payload = { event, ...data };
  if (level === "debug") {
    console.debug("[town]", payload);
    return;
  }
  if (level === "warn") {
    console.warn("[town]", payload);
    return;
  }
  console.info("[town]", payload);
}
