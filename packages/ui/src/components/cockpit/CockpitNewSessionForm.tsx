/**
 * Collects a coding-agent goal and cockpit mode selection, then emits the
 * orchestrator create-task input used to start a session.
 */
import { useId, useState } from "react";

import type { CodingAgentCreateTaskInput } from "../../api/client-types-cloud";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { CockpitModePicker } from "./CockpitModePicker";
import {
  buildCockpitCreateTaskInput,
  type CockpitModeConfig,
  type CockpitSpawnTarget,
  normalizeCockpitSpawnTarget,
} from "./cockpit-modes";

const DEFAULT_MODE: CockpitModeConfig = {
  mode: "eliza-cloud",
  agentType: "elizaos",
  tier: "small",
};

export interface CockpitNewSessionFormProps {
  /**
   * Called with the orchestrator create-task input when the user starts a
   * session. The optional {@link CockpitSpawnTarget} carries the repo/workdir to
   * thread into the second spawn step; `undefined` when the user left both blank
   * (scratch-dir default). Kept as a distinct second arg so the create-task body
   * stays pure — the target belongs to `addOrchestratorAgent`, not the task record.
   */
  onCreate: (
    input: CodingAgentCreateTaskInput,
    target?: CockpitSpawnTarget,
  ) => void | Promise<void>;
  /** Initial mode (defaults to Eliza Cloud · Fast). */
  defaultMode?: CockpitModeConfig;
  /**
   * Known repos to offer as autocomplete suggestions for the repo field (from
   * the project registry). When non-empty the repo input gets a `datalist`;
   * otherwise it's a plain text input — no invented dropdown.
   */
  knownRepos?: readonly string[];
  /** Whether repo suggestions are unavailable because the project registry failed. */
  repoSuggestionsUnavailable?: boolean;
  /** Arm the TOS-unsafe experimental options in the picker. */
  experimentalEnabled?: boolean;
  /** Parent-controlled in-flight flag (disables submit + shows "Starting…"). */
  busy?: boolean;
  className?: string;
}

/**
 * The "spawn a coding session" form for the cockpit: a free-text goal + the
 * per-session {@link CockpitModePicker}. On submit it lowers the selected mode to
 * the orchestrator `providerPolicy` (via `buildCockpitCreateTaskInput`) and hands
 * the parent a ready `CodingAgentCreateTaskInput` to POST to
 * `/api/orchestrator/tasks`. This is the missing "wire the picker into spawn"
 * piece — it produces the real create-task body, no free-text framework/model.
 */
export function CockpitNewSessionForm({
  onCreate,
  defaultMode = DEFAULT_MODE,
  knownRepos = [],
  repoSuggestionsUnavailable = false,
  experimentalEnabled = false,
  busy = false,
  className,
}: CockpitNewSessionFormProps) {
  const [mode, setMode] = useState<CockpitModeConfig>(defaultMode);
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState("");
  const [workdir, setWorkdir] = useState("");
  const repoListId = useId();

  const hasWorkdirWithoutRepo =
    workdir.trim().length > 0 && repo.trim().length === 0;
  const canSubmit = goal.trim().length > 0 && !hasWorkdirWithoutRepo && !busy;

  const submit = () => {
    if (!canSubmit) return;
    void onCreate(
      buildCockpitCreateTaskInput({ goal, mode }),
      normalizeCockpitSpawnTarget({ repo, workdir }),
    );
  };

  const hasKnownRepos = knownRepos.length > 0;

  return (
    <form
      data-testid="cockpit-new-session-form"
      className={cn("flex flex-col gap-3", className)}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor="cockpit-goal-input" className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-muted">
          What should the agent do?
        </span>
        <Textarea
          id="cockpit-goal-input"
          data-testid="cockpit-goal-input"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. Fix the failing auth tests in this repo and open a PR"
          rows={3}
          // Cmd/Ctrl+Enter submits (the composer convention).
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      </label>

      <label htmlFor="cockpit-repo-input" className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-muted">
          Repo <span className="font-normal text-muted">(optional)</span>
        </span>
        <Input
          id="cockpit-repo-input"
          data-testid="cockpit-repo-input"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="owner/repo or https://github.com/owner/repo"
          disabled={busy}
          list={hasKnownRepos ? repoListId : undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        {hasKnownRepos ? (
          <datalist id={repoListId} data-testid="cockpit-repo-suggestions">
            {knownRepos.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        ) : null}
        <span className="text-[11px] text-muted">
          {repoSuggestionsUnavailable
            ? "Repo suggestions are unavailable. Enter a repo manually or leave blank for a scratch workspace."
            : "Leave blank to run in a scratch workspace."}
        </span>
      </label>

      <label htmlFor="cockpit-workdir-input" className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-muted">
          Working directory{" "}
          <span className="font-normal text-muted">(optional)</span>
        </span>
        <Input
          id="cockpit-workdir-input"
          data-testid="cockpit-workdir-input"
          value={workdir}
          onChange={(e) => setWorkdir(e.target.value)}
          placeholder="e.g. packages/ui"
          disabled={busy}
          hasError={hasWorkdirWithoutRepo}
          aria-invalid={hasWorkdirWithoutRepo}
          aria-describedby={
            hasWorkdirWithoutRepo ? "cockpit-workdir-error" : undefined
          }
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        {hasWorkdirWithoutRepo ? (
          <span
            id="cockpit-workdir-error"
            data-testid="cockpit-workdir-error"
            role="alert"
            className="text-[11px] text-destructive"
          >
            Set a repo to target a working directory.
          </span>
        ) : null}
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-muted">Mode</span>
        <CockpitModePicker
          value={mode}
          onChange={setMode}
          experimentalEnabled={experimentalEnabled}
          disabled={busy}
        />
      </div>

      <Button
        type="submit"
        data-testid="cockpit-start-button"
        disabled={!canSubmit}
        className="w-full"
      >
        {busy ? "Starting…" : "Start agent"}
      </Button>
    </form>
  );
}
