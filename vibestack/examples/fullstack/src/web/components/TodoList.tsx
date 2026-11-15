// spec/client.md, "The user sees the queued edits applied over the confirmed copy, in order"
import { type Client, visible } from "../../../gen/client.ts";
import type { Op } from "../../../gen/todo.ts";
import { TodoRow } from "./TodoRow.tsx";

export interface TodoListProps {
  /** The tab: what it shows, and what its rules allow. */
  client: Client;
  /** An edit the user makes. */
  onEdit: (edit: Op) => void;
}

/**
 * The to-dos the user sees.
 * @model spec/client.md
 */
export function TodoList({ client, onEdit }: TodoListProps) {
  return <ul>{visible(client).map((todo) => <TodoRow key={todo.id} client={client} todo={todo} onEdit={onEdit} />)}</ul>;
}
