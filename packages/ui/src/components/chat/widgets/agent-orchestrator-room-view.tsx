/**
 * Presentational orchestrator ROOM view: renders each live coding-task room as
 * a card with its swarm of participants (the orchestrator, the owning user, and
 * every sub-agent) so an operator can see at a glance which agents are live,
 * what each is doing, and the multi-party state of the room.
 *
 * Props-driven and free of any data-layer (`client`) import (the same split as
 * `agent-orchestrator-accounts-view.tsx`) so it bundles for the browser and
 * renders in Storybook / the screenshot harness across every state. The
 * fetching container lives in `agent-orchestrator.tsx`.
 */
import { Bot, CircleUser, Users, Workflow, Wrench } from "lucide-react";
import { useMemo } from "react";
import type {
  OrchestratorRoomParticipant,
  OrchestratorRoomRoster,
  OrchestratorRoomRosterOverview,
} from "../../../api/client-types-cloud";
import type { TranslateFn } from "../../../types";
import { Button } from "../../ui/button";
import { fallbackTranslate } from "./agent-orchestrator-accounts-view";
import { EmptyWidgetState, WidgetSection } from "./shared";

/** Sub-agent session statuses that mean the session is finished. Mirrors the
 * orchestrator's TERMINAL_TASK_SESSION_STATUSES so a stopped agent reads as
 * idle, never live. */
const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "stopped",
  "completed",
  "done",
  "error",
  "errored",
  "cancelled",
]);

/** Task-room lifecycle states that mean the room is no longer working. */
const TERMINAL_ROOM_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "archived",
]);

function roomStatusTone(status: string): string {
  if (TERMINAL_ROOM_STATUSES.has(status)) return "bg-muted/50";
  if (status === "blocked" || status === "failed") return "bg-destructive";
  if (status === "waiting_on_user" || status === "validating") return "bg-warn";
  if (status === "interrupted") return "bg-warn";
  return "bg-ok";
}

/** A participant is "live" when it is a non-terminal, active sub-agent. The
 * orchestrator and user rows are always-present anchors, not live workers. */
function isLiveSubAgent(p: OrchestratorRoomParticipant): boolean {
  if (p.kind !== "sub_agent") return false;
  if (p.active === false) return false;
  return !TERMINAL_SESSION_STATUSES.has(p.status ?? "");
}

function participantIcon(kind: OrchestratorRoomParticipant["kind"]) {
  if (kind === "orchestrator") return Workflow;
  if (kind === "user") return CircleUser;
  return Bot;
}

/** Human-friendly status label for a sub-agent row. */
function statusLabel(p: OrchestratorRoomParticipant, t: TranslateFn): string {
  const status = p.status ?? "";
  if (p.activeTool) {
    return t("agentorchestrator.runningTool", {
      defaultValue: "{{tool}}",
      tool: p.activeTool,
    });
  }
  if (status === "tool_running")
    return t("agentorchestrator.statusToolRunning", {
      defaultValue: "running tool",
    });
  if (status === "running" || status === "busy")
    return t("agentorchestrator.statusWorking", { defaultValue: "working" });
  if (status === "ready")
    return t("agentorchestrator.statusReady", { defaultValue: "ready" });
  if (TERMINAL_SESSION_STATUSES.has(status))
    return t("agentorchestrator.statusDone", { defaultValue: "done" });
  return status || t("agentorchestrator.statusIdle", { defaultValue: "idle" });
}

function ParticipantRow({
  participant,
  t,
}: {
  participant: OrchestratorRoomParticipant;
  t: TranslateFn;
}) {
  const Icon = participantIcon(participant.kind);
  const live = isLiveSubAgent(participant);
  const isSubAgent = participant.kind === "sub_agent";
  const tokens =
    typeof participant.totalTokens === "number" && participant.totalTokens > 0
      ? `${Math.round(participant.totalTokens / 1000)}k`
      : null;

  return (
    <div
      className="flex items-center gap-1.5 py-0.5"
      data-testid="room-participant"
    >
      <span className="relative inline-flex shrink-0">
        <Icon
          className={`h-3.5 w-3.5 ${
            isSubAgent ? (live ? "text-txt" : "text-muted/50") : "text-muted/70"
          }`}
        />
        {isSubAgent ? (
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full border border-bg ${
              live ? "bg-ok" : "bg-muted/40"
            }`}
            role="img"
            aria-label={
              live
                ? t("agentorchestrator.live", { defaultValue: "live" })
                : t("agentorchestrator.statusIdle", { defaultValue: "idle" })
            }
          />
        ) : null}
      </span>
      <span
        className={`truncate font-medium ${
          isSubAgent && !live ? "text-muted" : "text-txt"
        }`}
      >
        {participant.label}
      </span>
      {participant.framework ? (
        <span className="shrink-0 rounded-full bg-muted/10 px-1.5 py-0.5 text-3xs text-muted/70">
          {participant.framework}
        </span>
      ) : null}
      {isSubAgent ? (
        <span
          className={`ml-auto flex shrink-0 items-center gap-1 text-3xs ${
            participant.activeTool ? "text-accent" : "text-muted/70"
          }`}
        >
          {participant.activeTool ? <Wrench className="h-3 w-3" /> : null}
          <span className="max-w-[7rem] truncate">
            {statusLabel(participant, t)}
          </span>
        </span>
      ) : null}
      {tokens ? (
        <span className="shrink-0 tabular-nums text-3xs text-muted/60">
          {tokens}
        </span>
      ) : null}
    </div>
  );
}

function RoomCard({
  room,
  t,
  onSelectRoom,
}: {
  room: OrchestratorRoomRoster;
  t: TranslateFn;
  /** When set, the card header is a button that drills into this task room. */
  onSelectRoom?: (taskId: string) => void;
}) {
  // Orchestrator + user anchors first, then sub-agents (live before idle) so
  // the working swarm reads top-down without re-sorting the wire order.
  const orderedParticipants = useMemo(() => {
    const anchors = room.participants.filter((p) => p.kind !== "sub_agent");
    const subAgents = room.participants
      .filter((p) => p.kind === "sub_agent")
      .slice()
      .sort((a, b) => Number(isLiveSubAgent(b)) - Number(isLiveSubAgent(a)));
    return [...anchors, ...subAgents];
  }, [room.participants]);

  const header = (
    <>
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${roomStatusTone(room.status)}`}
        role="img"
        aria-label={room.status}
        title={room.status}
      />
      <span className="truncate text-2xs font-semibold text-txt">
        {room.taskTitle}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1 text-3xs text-muted">
        {room.multiParty ? (
          <Users
            className="h-3 w-3"
            aria-label={t("agentorchestrator.multiPartyRoom", {
              defaultValue: "Multi-party room",
            })}
          />
        ) : null}
        <span
          className="tabular-nums"
          title={t("agentorchestrator.activeAgents", {
            defaultValue: "{{count}} active",
            count: room.activeAgentCount,
          })}
        >
          {room.activeAgentCount}
        </span>
      </span>
    </>
  );

  return (
    <div className="space-y-1.5 p-2" data-testid="orchestrator-room-card">
      {onSelectRoom ? (
        <Button
          onClick={() => onSelectRoom(room.taskId)}
          aria-label={room.taskTitle}
          data-testid="orchestrator-room-open"
          variant="ghost"
          className="flex h-auto w-full items-center justify-start gap-1.5 whitespace-normal rounded-sm px-0 py-0 text-left font-normal transition-colors hover:bg-bg-hover"
        >
          {header}
        </Button>
      ) : (
        <div className="flex items-center gap-1.5">{header}</div>
      )}
      <div className="space-y-0.5">
        {orderedParticipants.map((p) => (
          <ParticipantRow
            key={`${room.taskId}:${p.kind}:${p.id}`}
            participant={p}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

export interface OrchestratorRoomViewProps {
  rooms: OrchestratorRoomRosterOverview | null;
  t?: TranslateFn;
  /**
   * When set, each room card becomes a button that drills into that task room
   * (the cockpit uses this; the chat-sidebar widget leaves it undefined, so the
   * deck stays presentational there).
   */
  onSelectRoom?: (taskId: string) => void;
}

/**
 * The live room swarm: one card per task room, each showing the room title +
 * status, an active-agent count, a multi-party indicator, and the participant
 * roster (orchestrator + user + sub-agents with their framework, live state,
 * active tool, and token usage).
 */
export function OrchestratorRoomView({
  rooms,
  t = fallbackTranslate,
  onSelectRoom,
}: OrchestratorRoomViewProps) {
  // Surface every non-terminal room so an operator sees the full live board, not
  // just rooms that currently have a busy worker (an idle room still matters).
  const liveRooms = useMemo(
    () =>
      (rooms?.rooms ?? []).filter(
        (room) => !TERMINAL_ROOM_STATUSES.has(room.status),
      ),
    [rooms],
  );

  const totalActive = useMemo(
    () => liveRooms.reduce((n, room) => n + room.activeAgentCount, 0),
    [liveRooms],
  );

  if (liveRooms.length === 0) {
    return (
      <WidgetSection
        title={t("agentorchestrator.rooms", { defaultValue: "Task rooms" })}
        icon={<Users className="h-4 w-4" />}
        testId="chat-widget-rooms"
      >
        <EmptyWidgetState
          icon={<Users className="h-5 w-5" />}
          title={t("agentorchestrator.noRooms", {
            defaultValue: "No active task rooms.",
          })}
          description={t("agentorchestrator.noRoomsHint", {
            defaultValue:
              "Sub-agents spawned for a coding task appear here as a live swarm.",
          })}
        />
      </WidgetSection>
    );
  }

  return (
    <WidgetSection
      title={t("agentorchestrator.rooms", { defaultValue: "Task rooms" })}
      icon={<Users className="h-4 w-4" />}
      action={
        <span
          className="shrink-0 rounded-full bg-muted/15 px-1.5 py-0.5 text-3xs font-medium text-muted"
          title={t("agentorchestrator.activeAgentsTotal", {
            defaultValue: "{{count}} active across {{rooms}} rooms",
            count: totalActive,
            rooms: liveRooms.length,
          })}
        >
          {t("agentorchestrator.activeShort", {
            defaultValue: "{{count}} live",
            count: totalActive,
          })}
        </span>
      }
      testId="chat-widget-rooms"
    >
      <div className="space-y-2" data-testid="orchestrator-room-list">
        {liveRooms.map((room) => (
          <RoomCard
            key={room.taskId}
            room={room}
            t={t}
            onSelectRoom={onSelectRoom}
          />
        ))}
      </div>
    </WidgetSection>
  );
}
