/** Composes the mobile coding cockpit route from deck, session, and terminal panes. */
import {
  Button,
  type CockpitSpawnTarget,
  CockpitView,
  type CodingAgentCreateTaskInput,
  client,
  type OrchestratorRoomRosterOverview,
} from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import {
  CockpitInteractiveTerminal,
  type CockpitTerminalTier,
} from "./CockpitInteractiveTerminal";
import { CockpitSessionPane } from "./CockpitSessionPane";

/** How often the deck re-polls the live task-room roster. */
const ROOMS_POLL_INTERVAL_MS = 4_000;

/**
 * Route container for the coding cockpit. Wires the presentational
 * `CockpitView` (`@elizaos/ui`) to the live orchestrator client: polls the
 * task-room roster (the deck) and spawns a new task from the mode-picker form's
 * lowered `providerPolicy`. Registered as the `cockpit` view in the plugin
 * manifest; the host mounts it as a full-bleed app-shell page.
 */
export function CockpitRoute() {
  const [rooms, setRooms] = useState<OrchestratorRoomRosterOverview | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Drill-in: which task room is focused (its session pane replaces the deck).
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // When set, a full-panel interactive eliza-code CLI (the "tap-in" pillar) is
  // open at the chosen Cerebras tier, overlaying the deck.
  const [terminalTier, setTerminalTier] = useState<CockpitTerminalTier | null>(
    null,
  );
  // Repo suggestions for the new-session form's repo field, sourced from the
  // project registry (the same list the project switcher reads). Best-effort:
  // an absent/empty registry just yields a plain text input, no dropdown.
  const [knownRepos, setKnownRepos] = useState<string[]>([]);
  const [repoSuggestionsUnavailable, setRepoSuggestionsUnavailable] =
    useState(false);

  const refresh = useCallback(async () => {
    try {
      setRooms(await client.getOrchestratorRooms());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load task rooms.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, ROOMS_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Load known repos once for the repo-field autocomplete. Registry-less hosts
  // (mobile/web) resolve to an empty list, so the field degrades to plain text.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { projects } = await client.listProjects();
        if (cancelled) return;
        const repos = Array.from(
          new Set(
            projects
              .map((p) => p.repoUrl?.trim())
              .filter((r): r is string => !!r),
          ),
        );
        setKnownRepos(repos);
        setRepoSuggestionsUnavailable(false);
      } catch {
        // error-policy:J4 Manual repo entry remains usable, while the form
        // distinguishes a failed registry from a legitimately empty registry.
        if (!cancelled) setRepoSuggestionsUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onCreateSession = useCallback(
    async (input: CodingAgentCreateTaskInput, target?: CockpitSpawnTarget) => {
      setBusy(true);
      try {
        // 1. Create the durable task record.
        const task = await client.createOrchestratorTask(input);
        // 2. SPAWN the coding agent into it. createOrchestratorTask only writes
        // the record — the sub-agent actually starts via addOrchestratorAgent.
        // Thread the picked mode (framework / providerSource / model) so the
        // chosen mode runs. NOT a follow-up message: that path silently spawns
        // the default opencode framework and discards the pick. The optional
        // repo/workdir target (from the form) is threaded here exactly as the
        // chat TASKS action does — the orchestrator route already accepts both
        // and resolves the spawn workdir/repo from them; omitted ⇒ scratch dir.
        const policy = input.providerPolicy;
        await client.addOrchestratorAgent(task.id, {
          framework: policy?.preferredFramework,
          providerSource: policy?.providerSource,
          model: policy?.model,
          task: input.goal,
          ...(target?.repo ? { repo: target.repo } : {}),
          ...(target?.workdir ? { workdir: target.workdir } : {}),
        });
        setError(null);
        await refresh();
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Couldn't start the session.",
        );
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // Drilled into a room → its focused session pane (transcript + controls +
  // the bubble drives THIS task). Back returns to the deck.
  if (selectedTaskId) {
    return (
      <CockpitSessionPane
        taskId={selectedTaskId}
        onBack={() => setSelectedTaskId(null)}
      />
    );
  }

  return (
    <div style={{ position: "relative", height: "100%", minHeight: 0 }}>
      <CockpitView
        rooms={rooms}
        onCreateSession={onCreateSession}
        className="pb-20"
        knownRepos={knownRepos}
        repoSuggestionsUnavailable={repoSuggestionsUnavailable}
        busy={busy}
        error={error}
        onSelectRoom={setSelectedTaskId}
      />

      {terminalTier === null ? (
        <div
          style={{
            position: "absolute",
            right: 16,
            bottom: 16,
            display: "flex",
            gap: 8,
            zIndex: 10,
          }}
        >
          <Button
            type="button"
            size="sm"
            data-testid="cockpit-open-terminal-fast"
            onClick={() => setTerminalTier("fast")}
          >
            ⌨ Terminal · Fast
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="cockpit-open-terminal-smart"
            onClick={() => setTerminalTier("smart")}
          >
            ⌨ Terminal · Smart
          </Button>
        </div>
      ) : (
        <div
          data-testid="cockpit-terminal-overlay"
          style={{ position: "absolute", inset: 0, zIndex: 20 }}
        >
          <CockpitInteractiveTerminal
            tier={terminalTier}
            onClose={() => setTerminalTier(null)}
          />
        </div>
      )}
    </div>
  );
}
