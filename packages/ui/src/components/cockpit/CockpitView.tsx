/**
 * Composes the mobile-first coding cockpit deck, active room entry points, and
 * session-start form without owning the live orchestrator wiring.
 */
import { TerminalSquare } from "lucide-react";

import type {
  CodingAgentCreateTaskInput,
  OrchestratorRoomRosterOverview,
} from "../../api/client-types-cloud";
import { cn } from "../../lib/utils";
import { OrchestratorRoomView } from "../chat/widgets/agent-orchestrator-room-view";
import { CockpitNewSessionForm } from "./CockpitNewSessionForm";
import type { CockpitSpawnTarget } from "./cockpit-modes";

export interface CockpitViewProps {
  /** The live task-room roster (the deck). `null` while loading. */
  rooms: OrchestratorRoomRosterOverview | null;
  /**
   * Called with a ready create-task input when the user starts a session. The
   * optional {@link CockpitSpawnTarget} carries the repo/workdir to spawn against.
   */
  onCreateSession: (
    input: CodingAgentCreateTaskInput,
    target?: CockpitSpawnTarget,
  ) => void | Promise<void>;
  /** Known repos offered as repo-field autocomplete (from the project registry). */
  knownRepos?: readonly string[];
  /** Whether the project registry failed while loading repo suggestions. */
  repoSuggestionsUnavailable?: boolean;
  /** In-flight spawn (disables the form + shows "Starting…"). */
  busy?: boolean;
  /** Arm the TOS-unsafe experimental modes in the picker. */
  experimentalEnabled?: boolean;
  /** A surfaced error (e.g. spawn or roster fetch failed). */
  error?: string | null;
  /**
   * Drill into a task room (tap a deck card). When set, the deck cards become
   * buttons; the container swaps in the focused session pane. Omit to keep the
   * deck presentational.
   */
  onSelectRoom?: (taskId: string) => void;
  className?: string;
}

/**
 * The coding cockpit — one mobile-first view that unifies the coding-agent
 * workflow. Presentational + prop-driven (the live-client wiring lives in the
 * container that registers this as an app-shell page), so it is Storybook- and
 * test-verifiable. It composes:
 *
 *   - the live **deck** (`OrchestratorRoomView`, shaw's room-view widget) — one
 *     card per active task room with its swarm of sub-agents, and
 *   - the **session-start** form (mode picker → create-task `providerPolicy`).
 *
 * The driver bubble (host chat) manages these rooms; tapping a room drills into
 * its focused session pane (transcript + `TaskInspector` controls + a terminal-
 * output watch toggle + Fast/Smart tier toggle), and the bubble then drives THAT
 * task — all wired by the container (`CockpitRoute`). The "My Runtimes" switcher
 * lives in Settings.
 */
export function CockpitView({
  rooms,
  onCreateSession,
  knownRepos = [],
  repoSuggestionsUnavailable = false,
  busy = false,
  experimentalEnabled = false,
  error = null,
  onSelectRoom,
  className,
}: CockpitViewProps) {
  return (
    <div
      data-testid="cockpit-view"
      className={cn(
        "mx-auto flex h-full w-full max-w-2xl flex-col gap-4 overflow-y-auto p-4",
        className,
      )}
    >
      <header className="flex items-center gap-2">
        <TerminalSquare className="h-5 w-5 text-accent" />
        <h1 className="text-base font-semibold text-txt">Coding Cockpit</h1>
      </header>

      {error ? (
        <div
          data-testid="cockpit-error"
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <section data-testid="cockpit-deck">
        <OrchestratorRoomView rooms={rooms} onSelectRoom={onSelectRoom} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-txt">New session</h2>
        <CockpitNewSessionForm
          onCreate={onCreateSession}
          knownRepos={knownRepos}
          repoSuggestionsUnavailable={repoSuggestionsUnavailable}
          busy={busy}
          experimentalEnabled={experimentalEnabled}
        />
      </section>
    </div>
  );
}
