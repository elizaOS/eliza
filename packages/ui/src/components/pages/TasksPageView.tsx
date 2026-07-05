/**
 * Tasks — a top-level nav view that hosts the full-page task coordinator panel
 * under the shared, uniform `ViewHeader` (icon-only back + centered "Tasks"),
 * matching every other top-level view in the views-redesign epic (#13560).
 *
 * The shell header owns the back affordance and the title, so the panel is
 * mounted in its `fullPage` mode with its own internal title row suppressed —
 * one header per view, no duplication.
 */
import { CodingAgentTasksPanel } from "../../slots/task-coordinator-slots.js";
import { ViewHeader } from "../shared/ViewHeader";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

/**
 * The Tasks nav tab. The shared `ViewHeader` supplies the uniform top bar; the
 * panel renders its filters + list beneath it without a second heading.
 */
export function TasksPageView() {
  return (
    <ShellViewAgentSurface viewId="tasks">
      <div
        className="flex h-full min-h-0 w-full flex-col"
        data-testid="tasks-view"
      >
        <ViewHeader title="Tasks" />
        <div className="device-layout mx-auto flex min-h-0 w-full min-w-0 max-w-4xl flex-1 flex-col">
          <CodingAgentTasksPanel fullPage />
        </div>
      </div>
    </ShellViewAgentSurface>
  );
}
