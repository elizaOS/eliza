/**
 * Hosts the full-page task coordinator panel inside the Tasks shell view
 * without duplicating the panel's own header or empty state.
 */
import { CodingAgentTasksPanel } from "../../slots/task-coordinator-slots.js";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

/**
 * The Tasks nav tab. A thin host — the panel owns its own header, filters, and
 * empty state, so this wrapper adds no second heading or explanatory prose.
 */
export function TasksPageView() {
  return (
    <ShellViewAgentSurface viewId="tasks">
      <div
        className="device-layout mx-auto flex h-full w-full max-w-4xl flex-col"
        data-testid="tasks-view"
      >
        <CodingAgentTasksPanel fullPage />
      </div>
    </ShellViewAgentSurface>
  );
}
