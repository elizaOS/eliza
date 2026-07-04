/**
 * Storybook states for the Todo chat widget across populated, empty, and
 * interaction-focused render states.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { client } from "../../../api";
import type {
  WorkbenchOverview,
  WorkbenchTodo,
} from "../../../api/client-types-config";
import { mockApp } from "../../../storybook/mock-providers.helpers";
import { TODO_PLUGIN_WIDGETS } from "./todo";

/**
 * The chat-sidebar Todos widget seeds from `state.workbench.todos` and then
 * refreshes via `client.listWorkbenchTodos()`. In Storybook there is no
 * backend, so each story (a) seeds the mock app store with a workbench through
 * `mockApp` and (b) stubs `client.listWorkbenchTodos` so the silent refresh
 * resolves to the same data instead of rejecting. That gives a stable,
 * populated render. The widget renders an explicit empty state (not blank) when
 * there are no open todos, so the Empty story is safe for the story-gate.
 */
const TodoSidebarWidget = TODO_PLUGIN_WIDGETS[0].Component;

function todo(
  over: Partial<WorkbenchTodo> & { id: string; name: string },
): WorkbenchTodo {
  return {
    description: "",
    priority: null,
    isUrgent: false,
    isCompleted: false,
    type: "task",
    ...over,
  };
}

function workbench(todos: WorkbenchTodo[]): WorkbenchOverview {
  return { tasks: [], triggers: [], todos };
}

/** Seed the app store with a workbench AND stub the refresh fetch to match. */
function withTodos(todos: WorkbenchTodo[]): Decorator[] {
  // The widget seeds from `state.workbench.todos` synchronously, then runs a
  // silent refresh in an effect. Install the refresh stub for the render
  // lifetime (no synchronous restore) so the post-mount fetch resolves to the
  // same data instead of hitting the (absent) backend.
  const stub: Decorator = (Story) => {
    client.listWorkbenchTodos = async () => ({ todos });
    return <Story />;
  };
  return [stub, mockApp({ workbench: workbench(todos) })];
}

const meta = {
  title: "Chat/Widgets/TodoWidget",
  component: TodoSidebarWidget,
  tags: ["autodocs"],
  args: { events: [], clearEvents: () => {} },
} satisfies Meta<typeof TodoSidebarWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No open todos — renders the explicit "No open todos" empty state. */
export const Empty: Story = {
  decorators: withTodos([]),
};

/** A mix of urgent, prioritized, and plain todos with descriptions. */
export const Populated: Story = {
  decorators: withTodos([
    todo({
      id: "t1",
      name: "Ship the cloud-frontend audit fixes",
      description: "Resolve every needs-work page, then re-run audit:cloud.",
      priority: 1,
    }),
    todo({
      id: "t2",
      name: "Reply to the security disclosure",
      description: "Draft a response and loop in the maintainers.",
      isUrgent: true,
    }),
    todo({
      id: "t3",
      name: "Review the model-routing PR",
      type: "review",
    }),
    todo({
      id: "t4",
      name: "Renew the staging certificate",
      isCompleted: true,
    }),
  ]),
};

/** More open todos than the visible cap (8) — shows the "+N more" footer. */
export const ManyTodos: Story = {
  decorators: withTodos(
    Array.from({ length: 11 }, (_, i) =>
      todo({
        id: `m${i}`,
        name: `Backlog item ${i + 1}`,
        priority: i % 3 === 0 ? i + 1 : null,
      }),
    ),
  ),
};

/** A long description must clamp to two lines without breaking the card. */
export const LongDescription: Story = {
  decorators: withTodos([
    todo({
      id: "long-1",
      name: "Write the migration runbook",
      description:
        "Document the full cutover: pause writers, snapshot the database, run the schema migration, verify row counts against the previous snapshot, re-enable writers, and confirm the dashboard reflects the new fields before closing the change window.",
      priority: 2,
    }),
  ]),
};

/** Non-ASCII names and descriptions must render without mojibake. */
export const UnicodeTodos: Story = {
  decorators: withTodos([
    todo({
      id: "u1",
      name: "資料をレビューする 📑",
      description: "金曜日までに田中さんへ送付。",
      isUrgent: true,
    }),
    todo({
      id: "u2",
      name: "مراجعة العقد ✍️",
      description: "التوقيع قبل نهاية الأسبوع.",
      priority: 1,
    }),
  ]),
};
