/**
 * Collects a coding-agent goal and cockpit mode selection, then emits the
 * orchestrator create-task input used to start a session.
 */
import { useState } from "react";

import type { CodingAgentCreateTaskInput } from "../../api/client-types-cloud";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { CockpitModePicker } from "./CockpitModePicker";
import {
  buildCockpitCreateTaskInput,
  type CockpitModeConfig,
} from "./cockpit-modes";

const DEFAULT_MODE: CockpitModeConfig = {
  mode: "eliza-cloud",
  agentType: "elizaos",
  tier: "small",
};

export interface CockpitNewSessionFormProps {
  /** Called with the orchestrator create-task input when the user starts a session. */
  onCreate: (input: CodingAgentCreateTaskInput) => void | Promise<void>;
  /** Initial mode (defaults to Eliza Cloud · Fast). */
  defaultMode?: CockpitModeConfig;
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
  experimentalEnabled = false,
  busy = false,
  className,
}: CockpitNewSessionFormProps) {
  const [mode, setMode] = useState<CockpitModeConfig>(defaultMode);
  const [goal, setGoal] = useState("");

  const canSubmit = goal.trim().length > 0 && !busy;

  const submit = () => {
    if (!canSubmit) return;
    void onCreate(buildCockpitCreateTaskInput({ goal, mode }));
  };

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
