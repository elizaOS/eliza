import { ListTodo } from "lucide-react";
import { CodingAgentTasksPanel } from "../../slots/task-coordinator-slots.js";
import { useApp } from "../../state";
import { PagePanel } from "../composites/page-panel";

export function TasksPageView() {
  const { t } = useApp();

  return (
    <div
      className="device-layout mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 lg:px-6"
      data-testid="tasks-view"
    >
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-info/25 bg-info/12 text-info">
            <ListTodo className="h-4 w-4" />
          </span>
          <h1 className="text-lg font-semibold tracking-[-0.01em] text-txt">
            {t("taskseventspanel.Tasks", { defaultValue: "Tasks" })}
          </h1>
        </div>
        <p className="max-w-3xl text-sm leading-6 text-muted-strong">
          {t("taskseventspanel.TasksViewDescription", {
            defaultValue:
              "Detailed status, history, approvals, and coordinator output for coding-agent tasks.",
          })}
        </p>
      </div>

      <PagePanel
        variant="inset"
        className="min-h-[18rem] rounded-2xl p-4 lg:p-5"
      >
        <CodingAgentTasksPanel fullPage />
      </PagePanel>
    </div>
  );
}
