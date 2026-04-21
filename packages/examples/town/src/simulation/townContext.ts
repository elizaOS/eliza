import type { TownState } from "../../shared/types";
import type {
  MafiaGameUpdate,
  MafiaGameView,
  MafiaNightAction,
} from "./mafiaGame";
import type {
  MoveRequest,
  MoveResult,
  PointOfInterest,
  TownSimulation,
} from "./townSimulation";

export type TownContextSnapshot = {
  state: TownState;
  pointsOfInterest: PointOfInterest[];
};

export type TownGameActionResult = {
  success: boolean;
  message: string;
};

export type TownAgentActionResult = {
  success: boolean;
  message: string;
};

let activeSimulation: TownSimulation | null = null;

export function setTownSimulation(simulation: TownSimulation | null): void {
  activeSimulation = simulation;
}

export function getTownContextSnapshot(): TownContextSnapshot | null {
  if (!activeSimulation) {
    return null;
  }
  return {
    state: activeSimulation.getState(),
    pointsOfInterest: activeSimulation.getPointsOfInterest(),
  };
}

export function getTownGameView(agentId: string): MafiaGameView | null {
  if (!activeSimulation) {
    return null;
  }
  return activeSimulation.getGameViewForAgent(agentId);
}

export function queueTownMove(request: MoveRequest): MoveResult {
  if (!activeSimulation) {
    return {
      success: false,
      message: "Town simulation is not initialized.",
    };
  }
  return activeSimulation.queueMove(request);
}

export function stopTownAgent(agentId: string): TownAgentActionResult {
  if (!activeSimulation) {
    return {
      success: false,
      message: "Town simulation is not initialized.",
    };
  }
  const success = activeSimulation.stopAgent(agentId);
  return {
    success,
    message: success ? "Agent stopped." : "Agent not found.",
  };
}

export function emoteTownAgent(
  agentId: string,
  emote: string,
): TownAgentActionResult {
  if (!activeSimulation) {
    return {
      success: false,
      message: "Town simulation is not initialized.",
    };
  }
  const success = activeSimulation.recordEmote(agentId, emote);
  return {
    success,
    message: success ? "Emote sent." : "Agent not found.",
  };
}

export function startTownRound(): TownGameActionResult {
  return runGameUpdate((simulation) => simulation.startGameRound());
}

export function pauseTownGame(paused: boolean): TownGameActionResult {
  return runGameUpdate((simulation) => simulation.pauseGame(paused));
}

export function resetTownGame(): TownGameActionResult {
  return runGameUpdate((simulation) => simulation.resetGame());
}

export function advanceTownPhase(): TownGameActionResult {
  return runGameUpdate((simulation) => simulation.advanceGamePhase());
}

export function submitTownVote(
  voterId: string,
  target: string,
): TownGameActionResult {
  return runGameUpdate((simulation) => simulation.submitVote(voterId, target));
}

export function submitTownNightAction(
  action: MafiaNightAction,
): TownGameActionResult {
  return runGameUpdate((simulation) => simulation.submitNightAction(action));
}

export function recordTownMessage(params: {
  authorId: string;
  text: string;
  participants?: string[];
  createdAt?: number;
}): void {
  if (!activeSimulation) {
    return;
  }
  activeSimulation.recordMessage(params);
}

function runGameUpdate(
  run: (simulation: TownSimulation) => MafiaGameUpdate,
): TownGameActionResult {
  if (!activeSimulation) {
    return {
      success: false,
      message: "Town simulation is not initialized.",
    };
  }
  const update = run(activeSimulation);
  return { success: update.success, message: update.message };
}
