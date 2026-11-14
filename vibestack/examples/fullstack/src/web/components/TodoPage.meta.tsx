import type { ComponentMeta } from "../../../../../stories/meta.ts";
import type { TodoPageProps } from "./TodoPage.tsx";
import { offline, synced } from "./clients.ts";

export const meta: ComponentMeta<TodoPageProps> = {
  args: { client: synced, id: "a-3" },
  examples: { Offline: { client: offline, id: "a-4" } },
};
