/**
 * Exposes the production cockpit UI to the browser proof while replacing only
 * its HTTP client boundary with fetch calls that Playwright can observe.
 */

export type {
  CodingAgentCreateTaskInput,
  OrchestratorRoomRosterOverview,
} from "../../../../packages/ui/src/api/client-types-cloud";
export { CockpitView } from "../../../../packages/ui/src/components/cockpit/CockpitView";
export type { CockpitSpawnTarget } from "../../../../packages/ui/src/components/cockpit/cockpit-modes";
export { Button } from "../../../../packages/ui/src/components/ui/button";

export const DEFAULT_CEREBRAS_TEXT_MODEL = "gemma-4-31b";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://cockpit.test${path}`, init);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return (await response.json()) as T;
}

export const client = {
  getOrchestratorRooms: () => request("/api/orchestrator/rooms"),
  listProjects: () => request("/api/projects"),
  createOrchestratorTask: (body: unknown) =>
    request<{ id: string }>("/api/orchestrator/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  addOrchestratorAgent: (taskId: string, body: unknown) =>
    request(`/api/orchestrator/tasks/${taskId}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
};
