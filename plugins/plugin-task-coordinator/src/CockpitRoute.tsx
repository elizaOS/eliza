import {
  CockpitView,
  type CodingAgentCreateTaskInput,
  client,
  type OrchestratorRoomRosterOverview,
} from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";

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
        await client.createOrchestratorTask(input);
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

  return (
    <CockpitView
      rooms={rooms}
      onCreateSession={onCreateSession}
      busy={busy}
      error={error}
    />
  );
}
