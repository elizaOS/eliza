// spec/client.md, "An edit the user makes is checked against what they see, numbered and queued"
import { useState } from "react";
import { canCreate } from "../../../gen/client.ts";
import { Button } from "./Button.tsx";
import { Input } from "./Input.tsx";
import type { TodoListProps } from "./TodoList.tsx";

export type AddTodoProps = TodoListProps & {
  /** The id the next to-do of this tab gets: `newId` of sync.vibe. */
  id: string;
};

/**
 * Adds a to-do with the title typed.
 * @model spec/client.md
 */
export function AddTodo({ client, id, onEdit }: AddTodoProps) {
  const [draft, setDraft] = useState("");
  const title = draft.trim();
  const allowed = canCreate(client, id, title);
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!allowed) return;
        onEdit({ type: "create", id, title });
        setDraft("");
      }}
    >
      <Input value={draft} aria-label="New to-do" onChange={(event) => setDraft(event.target.value)} />
      <Button type="submit" aria-label="Add" disabled={!allowed}>
        +
      </Button>
    </form>
  );
}
