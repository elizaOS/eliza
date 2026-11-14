// spec/client.md, "Story: Edit the list in the browser"; spec/client.md, "Story: Hear back from the server"
import { AddTodo, type AddTodoProps } from "./AddTodo.tsx";
import { SyncStatus, type SyncStatusProps } from "./SyncStatus.tsx";
import { TodoList } from "./TodoList.tsx";

export type TodoPageProps = AddTodoProps & SyncStatusProps;

/**
 * The page: one tab's view of the shared list.
 * @model spec/client.md
 * @design design.md
 */
export function TodoPage({ client, id, onEdit, onOnline }: TodoPageProps) {
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-6 px-4 py-8 text-lg">
      <header className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">To-do</h1>
        <SyncStatus client={client} onOnline={onOnline} />
      </header>
      <AddTodo client={client} id={id} onEdit={onEdit} />
      <TodoList client={client} onEdit={onEdit} />
    </main>
  );
}
