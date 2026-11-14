import { visible } from "../../../gen/client.ts";
import type { ComponentMeta } from "../../../../../stories/meta.ts";
import type { TodoRowProps } from "./TodoRow.tsx";
import { offline, synced } from "./clients.ts";

export const meta: ComponentMeta<TodoRowProps> = {
  args: { client: synced, todo: synced.confirmed[1] },
  examples: {
    Done: { todo: synced.confirmed[0] },
    Unanswered: { client: offline, todo: visible(offline)[2] },
  },
  // A list item needs its list.
  decorator: (story) => <ul>{story()}</ul>,
};
