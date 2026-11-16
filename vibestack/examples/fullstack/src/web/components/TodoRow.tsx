// spec/client.md, "An edit the user makes is checked against what they see, numbered and queued"
import { useState } from "react";
import { canQueue } from "../../../gen/client.ts";
import type { Op, Todo } from "../../../gen/todo.ts";
import { cn, focusRing } from "../lib/cn.ts";
import { Button } from "./Button.tsx";
import { Checkbox } from "./Checkbox.tsx";
import { Input } from "./Input.tsx";
import type { TodoListProps } from "./TodoList.tsx";

export type TodoRowProps = TodoListProps & { todo: Todo };

/**
 * One to-do: tick it, rename it in place by its title, or remove it. Faint while the server has not answered an edit of it.
 * @model spec/client.md
 */
export function TodoRow({ client, todo: { id, title, done }, onEdit }: TodoRowProps) {
  /** The title being typed, while renaming. */
  const [draft, setDraft] = useState<string>();
  const renamed = draft?.trim() ?? "";
  const stop = () => setDraft(undefined);
  const tick: Op = { tag: "SetDone", id, done: !done };
  const rename: Op = { tag: "Rename", id, title: renamed };
  const remove: Op = { tag: "Remove", id };
  return (
    <li className={cn("flex items-center gap-2 border-b py-2", client.pending.some((p) => p.op.id === id) && "opacity-50")}>
      <Checkbox checked={done} disabled={!canQueue(client, tick)} aria-label={`Mark ${title} ${done ? "not done" : "done"}`} onCheckedChange={() => onEdit(tick)} />
      {draft === undefined ? (
        <button type="button" disabled={!canQueue(client, { tag: "Rename", id, title })} aria-label={`Rename ${title}`} onClick={() => setDraft(title)} className={cn(focusRing, "flex-1 rounded-sm text-left", done && "text-muted-foreground line-through")}>
          {title}
        </button>
      ) : (
        <form
          className="flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (renamed !== title && canQueue(client, rename)) onEdit(rename);
            stop();
          }}
        >
          <Input autoFocus value={draft} onFocus={(event) => event.target.select()} aria-label={`New title of ${title}`} onChange={(event) => setDraft(event.target.value)} onBlur={stop} onKeyDown={(event) => event.key === "Escape" && stop()} />
        </form>
      )}
      <Button variant="ghost" aria-label={`Remove ${title}`} disabled={!canQueue(client, remove)} onClick={() => onEdit(remove)}>
        ×
      </Button>
    </li>
  );
}
