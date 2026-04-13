export type MafiaRole = "mafia" | "detective" | "doctor" | "citizen";
export type MafiaPhase = "setup" | "night" | "day" | "ended";
export type MafiaWinner = "none" | "mafia" | "town";

export type MafiaNightActionType = "kill" | "investigate" | "protect";

export type MafiaPlayerState = {
  agentId: string;
  alive: boolean;
  role: MafiaRole;
  revealedRole: MafiaRole | null;
};

export type MafiaNightAction = {
  actorId: string;
  type: MafiaNightActionType;
  target: string;
};

export type MafiaVote = {
  voterId: string;
  target: string;
};

export type MafiaInvestigation = {
  target: string;
  isMafia: boolean;
  round: number;
};

export type MafiaElimination = {
  agentId: string;
  reason: "mafia" | "vote";
  round: number;
  phase: "night" | "day";
  revealedRole: MafiaRole;
};

export type MafiaGameState = {
  phase: MafiaPhase;
  round: number;
  isPaused: boolean;
  winner: MafiaWinner;
  players: MafiaPlayerState[];
  votes: MafiaVote[];
  nightActions: MafiaNightAction[];
  investigations: Record<string, MafiaInvestigation | null>;
  eliminations: MafiaElimination[];
  lastEvent: string | null;
};

export type MafiaNightActionStatus = {
  mafiaRequired: boolean;
  mafiaSubmitted: boolean;
  detectiveRequired: boolean;
  detectiveSubmitted: boolean;
  doctorRequired: boolean;
  doctorSubmitted: boolean;
  ready: boolean;
};

export type MafiaVoteStatus = {
  aliveCount: number;
  requiredMajority: number;
  totalVotes: number;
  allVoted: boolean;
  leadingTarget: string | null;
  leadingCount: number;
  isTie: boolean;
  votesByTarget: Array<{ target: string; count: number }>;
  ready: boolean;
};

export type MafiaRoleBrief = {
  role: MafiaRole;
  name: string;
  goals: string[];
  nightAction: MafiaNightActionType | null;
};

export type MafiaGameView = {
  phase: MafiaPhase;
  round: number;
  isPaused: boolean;
  winner: MafiaWinner;
  you: {
    agentId: string;
    alive: boolean;
    role: MafiaRole;
    roleBrief: MafiaRoleBrief;
    lastInvestigation: MafiaInvestigation | null;
  };
  publicPlayers: Array<{
    agentId: string;
    alive: boolean;
    revealedRole: MafiaRole | null;
  }>;
  eliminations: MafiaElimination[];
  lastEvent: string | null;
  availableActions: {
    canVote: boolean;
    canKill: boolean;
    canInvestigate: boolean;
    canProtect: boolean;
    canAdvancePhase: boolean;
  };
};

export type MafiaGameUpdate = {
  state: MafiaGameState;
  success: boolean;
  message: string;
};

const ROLE_BRIEFS: Record<MafiaRole, MafiaRoleBrief> = {
  mafia: {
    role: "mafia",
    name: "Mafia",
    goals: [
      "Blend in during the day and avoid suspicion.",
      "At night, coordinate a kill to reduce the town.",
      "Lure targets away from groups before striking.",
      "Win when the mafia are equal to or outnumber the town.",
    ],
    nightAction: "kill",
  },
  detective: {
    role: "detective",
    name: "Detective",
    goals: [
      "Gather evidence without revealing yourself too early.",
      "Investigate one player each night.",
      "Stay near allies and complete objectives between investigations.",
      "Help the town eliminate the mafia.",
    ],
    nightAction: "investigate",
  },
  doctor: {
    role: "doctor",
    name: "Doctor",
    goals: [
      "Protect the town by saving targeted players.",
      "Choose one player to protect each night.",
      "Stick with others and keep objectives moving.",
      "Help the town eliminate the mafia.",
    ],
    nightAction: "protect",
  },
  citizen: {
    role: "citizen",
    name: "Citizen",
    goals: [
      "Observe, discuss, and vote out suspicious players.",
      "Complete objectives while staying near trusted allies.",
      "Work with the town to eliminate the mafia.",
    ],
    nightAction: null,
  },
};

export function createMafiaGameState(agentIds: string[]): MafiaGameState {
  const roles = assignRoles(agentIds);
  const players: MafiaPlayerState[] = agentIds.map((agentId, index) => ({
    agentId,
    alive: true,
    role: roles[index] ?? "citizen",
    revealedRole: null,
  }));
  const investigations: Record<string, MafiaInvestigation | null> = {};
  for (const player of players) {
    investigations[player.agentId] = null;
  }
  return {
    phase: "setup",
    round: 0,
    isPaused: false,
    winner: "none",
    players,
    votes: [],
    nightActions: [],
    investigations,
    eliminations: [],
    lastEvent: null,
  };
}

export function syncMafiaGameState(
  existing: MafiaGameState | null,
  agentIds: string[],
): MafiaGameState {
  if (!existing) {
    return createMafiaGameState(agentIds);
  }
  const playersById = new Map(
    existing.players.map((player) => [player.agentId, player]),
  );
  const nextPlayers: MafiaPlayerState[] = agentIds.map((agentId) => {
    const current = playersById.get(agentId);
    if (current) {
      return current;
    }
    return {
      agentId,
      alive: true,
      role: "citizen",
      revealedRole: null,
    };
  });
  const aliveMafia = nextPlayers.filter(
    (player) => player.alive && player.role === "mafia",
  ).length;
  const aliveTown = nextPlayers.filter(
    (player) => player.alive && player.role !== "mafia",
  ).length;
  let nextWinner = existing.winner;
  let nextPhase = existing.phase;
  if (nextWinner === "none") {
    if (aliveMafia === 0) {
      nextWinner = "town";
      nextPhase = "ended";
    } else if (aliveMafia >= aliveTown) {
      nextWinner = "mafia";
      nextPhase = "ended";
    }
  }
  const investigations: Record<string, MafiaInvestigation | null> = {};
  for (const player of nextPlayers) {
    investigations[player.agentId] =
      existing.investigations[player.agentId] ?? null;
  }
  const validAgentIds = new Set(agentIds);
  const filteredVotes = existing.votes.filter(
    (vote) => validAgentIds.has(vote.voterId) && validAgentIds.has(vote.target),
  );
  const filteredActions = existing.nightActions.filter(
    (action) =>
      validAgentIds.has(action.actorId) && validAgentIds.has(action.target),
  );
  return {
    ...existing,
    players: nextPlayers,
    votes: filteredVotes,
    nightActions: filteredActions,
    investigations,
    winner: nextWinner,
    phase: nextPhase,
  };
}

export function buildMafiaGameViewForAgent(
  state: MafiaGameState,
  agentId: string,
): MafiaGameView {
  const player = state.players.find((entry) => entry.agentId === agentId);
  const role = player?.role ?? "citizen";
  const roleBrief = ROLE_BRIEFS[role];
  const alive = player?.alive ?? false;
  const canAct = state.phase !== "ended" && !state.isPaused && alive;
  return {
    phase: state.phase,
    round: state.round,
    isPaused: state.isPaused,
    winner: state.winner,
    you: {
      agentId,
      alive,
      role,
      roleBrief,
      lastInvestigation: state.investigations[agentId] ?? null,
    },
    publicPlayers: state.players.map((entry) => ({
      agentId: entry.agentId,
      alive: entry.alive,
      revealedRole: entry.alive ? null : entry.revealedRole,
    })),
    eliminations: state.eliminations,
    lastEvent: state.lastEvent,
    availableActions: {
      canVote: canAct && state.phase === "day",
      canKill: canAct && state.phase === "night" && role === "mafia",
      canInvestigate: canAct && state.phase === "night" && role === "detective",
      canProtect: canAct && state.phase === "night" && role === "doctor",
      canAdvancePhase: !state.isPaused && state.phase !== "ended",
    },
  };
}

export function startMafiaRound(state: MafiaGameState): MafiaGameUpdate {
  if (state.phase !== "setup" && state.phase !== "ended") {
    return update(state, false, "Round already started.");
  }
  const baseState =
    state.phase === "ended"
      ? createMafiaGameState(state.players.map((player) => player.agentId))
      : state;
  const nextState: MafiaGameState = {
    ...baseState,
    phase: "night",
    round: 1,
    isPaused: false,
    winner: "none",
    votes: [],
    nightActions: [],
    lastEvent: "Night falls. The mafia chooses a target.",
  };
  return update(nextState, true, "Round started.");
}

export function pauseMafiaGame(
  state: MafiaGameState,
  paused: boolean,
): MafiaGameUpdate {
  if (state.phase === "ended") {
    return update(state, false, "Game already ended.");
  }
  if (state.isPaused === paused) {
    return update(
      state,
      false,
      paused ? "Game already paused." : "Game already running.",
    );
  }
  return update(
    { ...state, isPaused: paused },
    true,
    paused ? "Game paused." : "Game resumed.",
  );
}

export function resetMafiaGame(
  state: MafiaGameState,
  agentIds: string[],
): MafiaGameUpdate {
  const nextState = createMafiaGameState(agentIds);
  return update(
    {
      ...nextState,
      isPaused: state.isPaused,
    },
    true,
    "Game reset with new roles.",
  );
}

export function advanceMafiaPhase(state: MafiaGameState): MafiaGameUpdate {
  if (state.isPaused) {
    return update(state, false, "Game is paused.");
  }
  if (state.phase === "ended") {
    return update(state, false, "Game already ended.");
  }
  if (state.phase === "setup") {
    return startMafiaRound(state);
  }
  if (state.phase === "night") {
    const resolved = resolveNightActions(state);
    const winner = evaluateWinner(resolved.players);
    const nextState: MafiaGameState = {
      ...resolved,
      phase: winner === "none" ? "day" : "ended",
      winner,
      votes: [],
      nightActions: [],
      lastEvent:
        winner === "none"
          ? (resolved.lastEvent ?? "Dawn breaks. Discuss and vote.")
          : (resolved.lastEvent ?? "The game has ended."),
    };
    return update(nextState, true, "Night resolved.");
  }
  const resolved = resolveVotes(state);
  const winner = evaluateWinner(resolved.players);
  const nextState: MafiaGameState = {
    ...resolved,
    phase: winner === "none" ? "night" : "ended",
    winner,
    round: winner === "none" ? state.round + 1 : state.round,
    votes: [],
    nightActions: [],
    lastEvent:
      winner === "none"
        ? (resolved.lastEvent ?? "Night falls. The mafia chooses a target.")
        : (resolved.lastEvent ?? "The game has ended."),
  };
  return update(nextState, true, "Day resolved.");
}

export function submitMafiaVote(
  state: MafiaGameState,
  voterId: string,
  target: string,
): MafiaGameUpdate {
  if (state.phase !== "day") {
    return update(state, false, "Voting is only allowed during the day.");
  }
  if (state.isPaused) {
    return update(state, false, "Game is paused.");
  }
  if (state.winner !== "none") {
    return update(state, false, "Game has ended.");
  }
  if (!isAlive(state, voterId)) {
    return update(state, false, "You are not alive.");
  }
  if (!isAlive(state, target)) {
    return update(state, false, "Target is not alive.");
  }
  const filtered = state.votes.filter((vote) => vote.voterId !== voterId);
  const nextState: MafiaGameState = {
    ...state,
    votes: [...filtered, { voterId, target }],
    lastEvent: "Votes are being cast.",
  };
  return update(nextState, true, "Vote recorded.");
}

export function submitMafiaNightAction(
  state: MafiaGameState,
  action: MafiaNightAction,
): MafiaGameUpdate {
  if (state.phase !== "night") {
    return update(state, false, "Night actions are only allowed at night.");
  }
  if (state.isPaused) {
    return update(state, false, "Game is paused.");
  }
  if (state.winner !== "none") {
    return update(state, false, "Game has ended.");
  }
  if (!isAlive(state, action.actorId)) {
    return update(state, false, "You are not alive.");
  }
  if (!isAlive(state, action.target)) {
    return update(state, false, "Target is not alive.");
  }
  const actorRole = getRole(state, action.actorId);
  if (action.type === "kill" && actorRole !== "mafia") {
    return update(state, false, "Only mafia can choose a kill target.");
  }
  if (action.type === "investigate" && actorRole !== "detective") {
    return update(state, false, "Only the detective can investigate.");
  }
  if (action.type === "protect" && actorRole !== "doctor") {
    return update(state, false, "Only the doctor can protect.");
  }
  const filtered = state.nightActions.filter(
    (entry) => entry.actorId !== action.actorId || entry.type !== action.type,
  );
  const nextState: MafiaGameState = {
    ...state,
    nightActions: [...filtered, action],
    lastEvent: "Night actions are underway.",
  };
  return update(nextState, true, "Night action recorded.");
}

function update(
  state: MafiaGameState,
  success: boolean,
  message: string,
): MafiaGameUpdate {
  return { state, success, message };
}

function assignRoles(agentIds: string[]): MafiaRole[] {
  if (agentIds.length === 0) {
    return [];
  }
  const shuffled = shuffle(agentIds);
  const total = shuffled.length;
  const mafiaCount = Math.max(1, Math.floor(total / 4));
  const roles: MafiaRole[] = [];
  for (let i = 0; i < mafiaCount && roles.length < total; i += 1) {
    roles.push("mafia");
  }
  if (roles.length < total) {
    roles.push("detective");
  }
  if (roles.length < total) {
    roles.push("doctor");
  }
  while (roles.length < total) {
    roles.push("citizen");
  }
  return shuffle(roles);
}

function shuffle<T>(items: T[]): T[] {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const current = next[i];
    next[i] = next[j] ?? next[i];
    next[j] = current;
  }
  return next;
}

function isAlive(state: MafiaGameState, agentId: string): boolean {
  const player = state.players.find((entry) => entry.agentId === agentId);
  return player ? player.alive : false;
}

function getRole(state: MafiaGameState, agentId: string): MafiaRole {
  const player = state.players.find((entry) => entry.agentId === agentId);
  return player?.role ?? "citizen";
}

function resolveNightActions(state: MafiaGameState): MafiaGameState {
  const mafiaTarget = pickNightTarget(state, "kill");
  const doctorTarget = pickNightTarget(state, "protect");
  const investigations = { ...state.investigations };
  const players = state.players.map((entry) => ({ ...entry }));
  const eliminations = [...state.eliminations];
  let lastEvent: string | null = "The night passes quietly.";

  for (const action of state.nightActions) {
    if (action.type !== "investigate") {
      continue;
    }
    if (!isAlive(state, action.actorId) || !isAlive(state, action.target)) {
      continue;
    }
    const isMafia = getRole(state, action.target) === "mafia";
    investigations[action.actorId] = {
      target: action.target,
      isMafia,
      round: state.round,
    };
    lastEvent = "A quiet investigation uncovers new clues.";
  }

  if (
    mafiaTarget &&
    mafiaTarget !== doctorTarget &&
    isAlive(state, mafiaTarget)
  ) {
    const victim = players.find((entry) => entry.agentId === mafiaTarget);
    if (victim) {
      victim.alive = false;
      victim.revealedRole = victim.role;
      eliminations.push({
        agentId: victim.agentId,
        reason: "mafia",
        round: state.round,
        phase: "night",
        revealedRole: victim.role,
      });
      lastEvent = "The mafia strikes during the night.";
    }
  } else if (mafiaTarget && mafiaTarget === doctorTarget) {
    lastEvent = "A doctor intervenes and saves a life.";
  }

  return {
    ...state,
    players,
    investigations,
    eliminations,
    lastEvent,
  };
}

function resolveVotes(state: MafiaGameState): MafiaGameState {
  const votes = state.votes.filter(
    (vote) => isAlive(state, vote.voterId) && isAlive(state, vote.target),
  );
  const tally = new Map<string, number>();
  for (const vote of votes) {
    tally.set(vote.target, (tally.get(vote.target) ?? 0) + 1);
  }
  let topTarget: string | null = null;
  let topVotes = 0;
  let tie = false;
  for (const [target, count] of tally.entries()) {
    if (count > topVotes) {
      topVotes = count;
      topTarget = target;
      tie = false;
    } else if (count === topVotes) {
      tie = true;
    }
  }
  const players = state.players.map((entry) => ({ ...entry }));
  const eliminations = [...state.eliminations];
  let lastEvent: string | null = "The town debates with uncertainty.";
  if (topTarget && !tie) {
    const target = players.find((entry) => entry.agentId === topTarget);
    if (target?.alive) {
      target.alive = false;
      target.revealedRole = target.role;
      eliminations.push({
        agentId: target.agentId,
        reason: "vote",
        round: state.round,
        phase: "day",
        revealedRole: target.role,
      });
      lastEvent = "The town reaches a verdict and votes someone out.";
    }
  } else if (tie) {
    lastEvent = "The vote is tied; no one is eliminated.";
  }
  return {
    ...state,
    players,
    eliminations,
    lastEvent,
  };
}

function pickNightTarget(
  state: MafiaGameState,
  type: MafiaNightActionType,
): string | null {
  const candidates = state.nightActions.filter((action) => {
    if (action.type !== type) {
      return false;
    }
    if (!isAlive(state, action.actorId) || !isAlive(state, action.target)) {
      return false;
    }
    const role = getRole(state, action.actorId);
    if (type === "kill") {
      return role === "mafia";
    }
    if (type === "protect") {
      return role === "doctor";
    }
    if (type === "investigate") {
      return role === "detective";
    }
    return false;
  });
  const last = candidates[candidates.length - 1];
  return last ? last.target : null;
}

function evaluateWinner(players: MafiaPlayerState[]): MafiaWinner {
  const alive = players.filter((player) => player.alive);
  const mafia = alive.filter((player) => player.role === "mafia").length;
  const town = alive.length - mafia;
  if (mafia === 0) {
    return "town";
  }
  if (mafia > 0 && mafia >= town) {
    return "mafia";
  }
  return "none";
}

export function getAlivePlayerIds(state: MafiaGameState): string[] {
  return state.players
    .filter((player) => player.alive)
    .map((player) => player.agentId);
}

export function getNightActionStatus(
  state: MafiaGameState,
): MafiaNightActionStatus {
  const mafiaRequired = hasAliveRole(state, "mafia");
  const detectiveRequired = hasAliveRole(state, "detective");
  const doctorRequired = hasAliveRole(state, "doctor");
  const mafiaSubmitted = state.nightActions.some(
    (action) => action.type === "kill" && isAlive(state, action.actorId),
  );
  const detectiveSubmitted = state.nightActions.some(
    (action) => action.type === "investigate" && isAlive(state, action.actorId),
  );
  const doctorSubmitted = state.nightActions.some(
    (action) => action.type === "protect" && isAlive(state, action.actorId),
  );
  const ready =
    (!mafiaRequired || mafiaSubmitted) &&
    (!detectiveRequired || detectiveSubmitted) &&
    (!doctorRequired || doctorSubmitted);
  return {
    mafiaRequired,
    mafiaSubmitted,
    detectiveRequired,
    detectiveSubmitted,
    doctorRequired,
    doctorSubmitted,
    ready,
  };
}

export function getVoteStatus(state: MafiaGameState): MafiaVoteStatus {
  const aliveCount = getAlivePlayerIds(state).length;
  const requiredMajority = aliveCount > 0 ? Math.floor(aliveCount / 2) + 1 : 0;
  const validVotes = state.votes.filter(
    (vote) => isAlive(state, vote.voterId) && isAlive(state, vote.target),
  );
  const tally = new Map<string, number>();
  for (const vote of validVotes) {
    tally.set(vote.target, (tally.get(vote.target) ?? 0) + 1);
  }
  let leadingTarget: string | null = null;
  let leadingCount = 0;
  let isTie = false;
  for (const [target, count] of tally.entries()) {
    if (count > leadingCount) {
      leadingCount = count;
      leadingTarget = target;
      isTie = false;
    } else if (count === leadingCount) {
      isTie = true;
    }
  }
  const votesByTarget = Array.from(tally.entries())
    .map(([target, count]) => ({ target, count }))
    .sort((a, b) => b.count - a.count);
  const totalVotes = validVotes.length;
  const allVoted = aliveCount > 0 && totalVotes >= aliveCount;
  const ready =
    allVoted || (leadingTarget !== null && leadingCount >= requiredMajority);
  return {
    aliveCount,
    requiredMajority,
    totalVotes,
    allVoted,
    leadingTarget,
    leadingCount,
    isTie,
    votesByTarget,
    ready,
  };
}

function hasAliveRole(state: MafiaGameState, role: MafiaRole): boolean {
  return state.players.some((player) => player.alive && player.role === role);
}
