import type { ComponentMeta } from "../../../../../stories/meta.ts";
import type { TodoListProps } from "./TodoList.tsx";
import { offline, synced } from "./clients.ts";

export const meta: ComponentMeta<TodoListProps> = {
  args: { client: synced },
  examples: { Offline: { client: offline } },
};
