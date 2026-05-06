import { PagePanel } from "@elizaos/ui";
import { CodingAgentTasksPanel } from "../../slots/task-coordinator-slots.js";
import { useApp } from "../../state";

export function TasksPageView() {
  const { t } = useApp();

  return (
    <div className="device-layout mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 lg:px-6">
      <div className="space-y-1.5">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-txt">
          {t("taskseventspanel.Tasks", { defaultValue: "Tasks" })}
        </h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-strong">
          {t("taskseventspanel.TasksViewDescription", {
            defaultValue:
              "Detailed status, history, approvals, and coordinator output for coding-agent tasks.",
          })}
        </p>
      </div>

      <PagePanel variant="inset" className="rounded-2xl p-4 lg:p-5">
        <CodingAgentTasksPanel fullPage />
      </PagePanel>
    </div>
  );
}
