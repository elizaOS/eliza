// Composes the mobile coding cockpit route from deck, session, and terminal panes.
import {
  Button,
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

  const onCreateSession = useCallback(
    async (input: CodingAgentCreateTaskInput) => {
      setBusy(true);
      try {
        // 1. Create the durable task record.
        const task = await client.createOrchestratorTask(input);
        // 2. SPAWN the coding agent into it. createOrchestratorTask only writes
        // the record — the sub-agent actually starts via addOrchestratorAgent.
        // Thread the picked mode (framework / providerSource / model) so the
        // chosen mode runs. NOT a follow-up message: that path silently spawns
        // the default opencode framework and discards the pick. (workdir is left
        // to the orchestrator's default resolution; a cwd/repo picker is a
        // follow-up.)
        const policy = input.providerPolicy;
        await client.addOrchestratorAgent(task.id, {
          framework: policy?.preferredFramework,
          providerSource: policy?.providerSource,
          model: policy?.model,
          task: input.goal,
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
