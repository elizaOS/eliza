import { Check, ListChecks } from "lucide-react";
import type { LandingDemoTaskList } from "@/lib/landing-demo";

export function LandingTaskListAttachment({
  taskList,
}: {
  taskList: LandingDemoTaskList;
}) {
  const completed = taskList.items.filter((item) => item.completed).length;

  return (
    <article
      className="landing-task-list-attachment"
      aria-label={`${taskList.title}, ${completed} of ${taskList.items.length} items completed`}
    >
      <header className="landing-task-list-head landing-attachment-head">
        <span
          className="landing-task-list-icon landing-attachment-icon"
          aria-hidden="true"
        >
          <ListChecks />
        </span>
        <span>
          <strong>{taskList.title}</strong>
        </span>
        <b>{completed} done</b>
      </header>
      <ul className="landing-task-list-items">
        {taskList.items.map((item) => (
          <li
            key={`${item.assignee}-${item.task}`}
            data-completed={item.completed}
          >
            <span className="landing-task-check" aria-hidden="true">
              {item.completed ? <Check /> : null}
            </span>
            <span className="landing-task-list-copy">
              <strong>{item.task}</strong>
              <small>{item.assignee}</small>
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}
