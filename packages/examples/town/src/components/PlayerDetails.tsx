import { useMemo, useState } from "react";
import { TOWN_AGENTS } from "../../shared/agents";
import type { TownState } from "../../shared/types";
import { useModelSettings } from "../hooks/useModelSettings";
import {
  useResetGame,
  useSetRunning,
  useStartGameRound,
} from "../hooks/useTownControls";
import { useTownGameState } from "../hooks/useTownGameState";
import { getNightActionStatus, getVoteStatus } from "../simulation/mafiaGame";
import type { SelectElement } from "./Player";

type PlayerDetailsProps = {
  state: TownState;
  selectedAgentId?: string;
  setSelectedElement: SelectElement;
  onOpenSettings: () => void;
  isRunning: boolean;
  canRun: boolean;
};

export default function PlayerDetails({
  state,
  selectedAgentId,
  setSelectedElement,
  onOpenSettings,
  isRunning,
  canRun,
}: PlayerDetailsProps) {
  const selectedAgent = state.agents.find(
    (agent) => agent.id === selectedAgentId,
  );
  const selectedProfile = TOWN_AGENTS.find(
    (agent) => agent.id === selectedAgentId,
  );
  const gameState = useTownGameState();
  const startGameRound = useStartGameRound();
  const resetGame = useResetGame();
  const setRunning = useSetRunning();
  const settings = useModelSettings();
  const [suspectedMafia, setSuspectedMafia] = useState<string[]>([]);
  const [revealRoles, _setRevealRoles] = useState(false);

  const agentNameById = useMemo(() => {
    return new Map(state.agents.map((agent) => [agent.id, agent.name]));
  }, [state.agents]);
  const agentStateById = useMemo(() => {
    return new Map(state.agents.map((agent) => [agent.id, agent]));
  }, [state.agents]);
  const objectives = state.objectives ?? [];
  const assignedObjectives = selectedAgentId
    ? objectives.filter((objective) =>
        objective.assignedAgentIds.includes(selectedAgentId),
      )
    : [];
  const assignedCompleted = assignedObjectives.filter(
    (objective) => objective.status === "completed",
  ).length;
  const objectiveCompleted = objectives.filter(
    (objective) => objective.status === "completed",
  ).length;

  const sheriffId = gameState?.players.find(
    (player) => player.role === "detective",
  )?.agentId;
  const canRevealRoles = gameState?.winner !== "none";
  const showAllRoles = Boolean(revealRoles && canRevealRoles);
  const nightStatus = useMemo(
    () => (gameState ? getNightActionStatus(gameState) : null),
    [gameState],
  );
  const voteStatus = useMemo(
    () => (gameState ? getVoteStatus(gameState) : null),
    [gameState],
  );
  const aliveCount =
    gameState?.players.filter((player) => player.alive).length ?? 0;
  const deadCount = gameState?.players.length
    ? gameState.players.length - aliveCount
    : 0;
  const canStartRound = Boolean(
    gameState &&
      canRun &&
      (gameState.phase === "setup" || gameState.phase === "ended"),
  );
  const canResumeRound = Boolean(
    gameState &&
      canRun &&
      (gameState.phase === "night" || gameState.phase === "day"),
  );
  const canToggleRound = isRunning || canStartRound || canResumeRound;
  const canResetRound = Boolean(gameState && canRun);

  const handleStartPause = () => {
    if (isRunning) {
      setRunning(false);
      return;
    }
    startGameRound();
  };

  const toggleSuspect = (agentId: string) => {
    setSuspectedMafia((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId],
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Control buttons - always visible at top */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="button text-white shadow-solid text-xs cursor-pointer"
          onClick={handleStartPause}
          disabled={!canToggleRound}
        >
          <div className="h-full bg-clay-700 text-center px-3 py-1">
            {isRunning
              ? "Pause Round"
              : canResumeRound
                ? "Resume Round"
                : "Start Round"}
          </div>
        </button>
        <button
          type="button"
          className="button text-white shadow-solid text-xs cursor-pointer"
          onClick={resetGame}
          disabled={!canResetRound}
        >
          <div className="h-full bg-clay-700 text-center px-3 py-1">
            Reset Round
          </div>
        </button>
        <button
          type="button"
          className="button text-white shadow-solid text-xs cursor-pointer"
          onClick={onOpenSettings}
        >
          <div className="h-full bg-clay-700 text-center px-3 py-1">
            Settings
          </div>
        </button>
      </div>

      {!canRun && (
        <div className="text-xs opacity-80">
          {settings.provider === "local"
            ? "Local AI doesn't work in browsers. Select a cloud provider (OpenAI, Anthropic, etc.) and add an API key."
            : "Add the required API key for your selected provider to start the round."}
        </div>
      )}

      {/* Game state box */}
      <div className="box w-full">
        <div className="flex flex-col gap-4 p-3 text-sm">
          {gameState ? (
            <>
              <div className="flex flex-wrap gap-3 text-xs uppercase tracking-wider opacity-80">
                <span>Phase: {gameState.phase}</span>
                <span>Round: {gameState.round}</span>
                {gameState.winner !== "none" && (
                  <span>Winner: {gameState.winner}</span>
                )}
              </div>
              <div className="text-xs uppercase tracking-wider opacity-80">
                Alive: {aliveCount} · Dead: {deadCount}
              </div>
              <div className="text-xs opacity-80">
                Automation: {isRunning ? "live" : "paused"}
              </div>
              <div className="text-xs opacity-80">
                Objectives: {objectiveCompleted}/{objectives.length} completed
              </div>
              {gameState.lastEvent && (
                <div className="text-xs opacity-80">
                  Last event: {gameState.lastEvent}
                </div>
              )}
              {sheriffId && (
                <div className="text-xs opacity-90">
                  Sheriff: {agentNameById.get(sheriffId) ?? sheriffId}
                </div>
              )}

              <div className="mt-2 text-xs uppercase tracking-wider opacity-70">
                Players
              </div>
              <div className="flex flex-col gap-2">
                {gameState.players.map((player) => {
                  const name =
                    agentNameById.get(player.agentId) ?? player.agentId;
                  const isDead = !player.alive;
                  const roleLabel = formatRoleLabel(player.role);
                  const revealedRole = player.revealedRole
                    ? formatRoleLabel(player.revealedRole)
                    : null;
                  const showRole =
                    showAllRoles ||
                    revealedRole !== null ||
                    player.role === "detective";
                  const isSelected = selectedAgentId === player.agentId;
                  const agentState = agentStateById.get(player.agentId);
                  const statusLabel = agentState?.status ?? "idle";
                  return (
                    <div
                      key={player.agentId}
                      className={`rounded border px-3 py-2 ${
                        isDead
                          ? "border-brown-600/60 opacity-70"
                          : "border-brown-700/80"
                      } ${isSelected ? "ring-2 ring-amber-300" : ""}`}
                    >
                      <button
                        type="button"
                        className="w-full text-left"
                        onClick={() =>
                          setSelectedElement({
                            kind: "player",
                            id: player.agentId,
                          })
                        }
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-semibold">{name}</div>
                          <div className="text-xs uppercase tracking-wider">
                            {isDead ? "dead" : "alive"} · {statusLabel}
                          </div>
                        </div>
                        {isSelected && selectedProfile && (
                          <div className="mt-1 text-xs opacity-80">
                            {selectedProfile.description}
                          </div>
                        )}
                        {isSelected && selectedAgent && (
                          <div className="mt-1 text-xs opacity-80">
                            Vision: {selectedAgent.visionRangeTiles} tiles ·
                            Hearing: {selectedAgent.audioRangeTiles} tiles
                          </div>
                        )}
                        {isSelected && selectedAgent?.lastMessage && (
                          <div className="mt-1 text-xs italic">
                            “{selectedAgent.lastMessage}”
                          </div>
                        )}
                      </button>
                      {showRole && (
                        <div className="text-xs opacity-80">
                          Role: {revealedRole ?? roleLabel}
                        </div>
                      )}
                      {suspectedMafia.includes(player.agentId) && (
                        <div className="text-xs text-amber-200">
                          Marked as mafia
                        </div>
                      )}
                      {!isDead && (
                        <button
                          type="button"
                          className="mt-2 text-xs underline"
                          onClick={() => toggleSuspect(player.agentId)}
                        >
                          {suspectedMafia.includes(player.agentId)
                            ? "Remove mafia guess"
                            : "Mark as mafia"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {gameState.eliminations.length > 0 && (
                <div className="mt-3 rounded border border-brown-700/80 p-3 text-xs space-y-2">
                  <div className="uppercase tracking-wider opacity-80">
                    Eliminations
                  </div>
                  {gameState.eliminations.map((entry, index) => (
                    <div key={`${entry.agentId}-${entry.round}-${index}`}>
                      {agentNameById.get(entry.agentId) ?? entry.agentId} ·{" "}
                      {entry.revealedRole} · {entry.reason} · round{" "}
                      {entry.round} ({entry.phase})
                    </div>
                  ))}
                </div>
              )}

              {gameState.phase === "night" && nightStatus && (
                <div className="mt-3 rounded border border-brown-700/80 p-3 text-xs space-y-2">
                  <div className="uppercase tracking-wider opacity-80">
                    Night actions
                  </div>
                  <div className="opacity-80">
                    Goal: mafia kill, sheriff investigate, doctor protect.
                  </div>
                  <div>
                    Mafia kill:{" "}
                    {formatActionStatus(
                      nightStatus.mafiaRequired,
                      nightStatus.mafiaSubmitted,
                    )}
                  </div>
                  <div>
                    Sheriff investigate:{" "}
                    {formatActionStatus(
                      nightStatus.detectiveRequired,
                      nightStatus.detectiveSubmitted,
                    )}
                  </div>
                  <div>
                    Doctor protect:{" "}
                    {formatActionStatus(
                      nightStatus.doctorRequired,
                      nightStatus.doctorSubmitted,
                    )}
                  </div>
                  <div className="opacity-70">
                    Auto-advance: {nightStatus.ready ? "ready" : "waiting"}
                  </div>
                </div>
              )}

              {gameState.phase === "day" && voteStatus && (
                <div className="mt-3 rounded border border-brown-700/80 p-3 text-xs space-y-2">
                  <div className="uppercase tracking-wider opacity-80">
                    Day vote
                  </div>
                  <div className="opacity-80">
                    Goal: majority vote to eliminate a suspect.
                  </div>
                  <div>
                    Votes: {voteStatus.totalVotes}/{voteStatus.aliveCount} (
                    {voteStatus.requiredMajority} to convict)
                  </div>
                  <div>
                    Leading:{" "}
                    {voteStatus.leadingTarget
                      ? `${agentNameById.get(voteStatus.leadingTarget) ?? voteStatus.leadingTarget} (${voteStatus.leadingCount})`
                      : "none"}
                  </div>
                  {voteStatus.isTie && (
                    <div className="opacity-80">Tie detected.</div>
                  )}
                  {voteStatus.votesByTarget.length > 0 && (
                    <div className="space-y-1">
                      {voteStatus.votesByTarget.map((entry) => (
                        <div key={entry.target}>
                          {agentNameById.get(entry.target) ?? entry.target}:{" "}
                          {entry.count}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="opacity-70">
                    Auto-advance: {voteStatus.ready ? "ready" : "waiting"}
                  </div>
                </div>
              )}

              <div className="mt-3 rounded border border-brown-700/80 p-3 text-xs space-y-2">
                <div className="uppercase tracking-wider opacity-80">
                  Objectives
                </div>
                {selectedAgentId ? (
                  <>
                    <div className="opacity-80">
                      {assignedCompleted}/{assignedObjectives.length} completed
                      for{" "}
                      {agentNameById.get(selectedAgentId) ?? selectedAgentId}
                    </div>
                    {assignedObjectives.length > 0 ? (
                      <div className="space-y-1">
                        {assignedObjectives.map((objective) => (
                          <div key={objective.id}>
                            {objective.status === "completed" ? "✓" : "•"}{" "}
                            {objective.title}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="opacity-70">No objectives assigned.</div>
                    )}
                  </>
                ) : (
                  <div className="opacity-70">
                    Select a player to see their assigned objectives.
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="text-xs opacity-80">Loading mafia state...</div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatRoleLabel(role: string): string {
  if (role === "detective") {
    return "Sheriff";
  }
  return role;
}

function formatActionStatus(required: boolean, submitted: boolean): string {
  if (!required) {
    return "not needed";
  }
  return submitted ? "submitted" : "pending";
}
