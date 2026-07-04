/**
 * Storybook states for the Browser Status chat widget across populated, empty,
 * and interaction-focused render states.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { client } from "../../../api";
import type {
  BrowserWorkspaceSnapshot,
  BrowserWorkspaceTab,
} from "../../../api/browser-contracts";
import { mockApp } from "../../../storybook/mock-providers.helpers";
import { BrowserStatusSidebarWidget } from "./browser-status";

/**
 * The chat-sidebar Browser widget polls `client.getBrowserWorkspace()` and
 * renders nothing until there are open tabs (it keeps the right rail quiet).
 * Every story therefore (a) stubs `getBrowserWorkspace` to return a populated
 * snapshot, restored after render, and (b) seeds the mock app store so the
 * `setTab` selector resolves. There is no empty story because the no-tabs
 * render is null (blank), which the story-gate rejects.
 */
function tab(
  over: Partial<BrowserWorkspaceTab> & { id: string },
): BrowserWorkspaceTab {
  return {
    title: "",
    url: "https://example.com",
    partition: "default",
    visible: false,
    createdAt: "2024-01-08T10:00:00.000Z",
    updatedAt: "2024-01-08T10:00:00.000Z",
    lastFocusedAt: null,
    ...over,
  };
}

function withTabs(tabs: BrowserWorkspaceTab[]): Decorator[] {
  const snapshot: BrowserWorkspaceSnapshot = { mode: "desktop", tabs };
  // Install the stub for the story's render lifetime. The widget fetches the
  // snapshot in an effect (after this decorator returns), so the override must
  // stay in place — a synchronous try/finally restore would revert it before
  // the fetch runs. Each story re-installs its own snapshot before rendering.
  const stub: Decorator = (Story) => {
    client.getBrowserWorkspace = async () => snapshot;
    return <Story />;
  };
  return [stub, mockApp({})];
}

const meta = {
  title: "Chat/Widgets/BrowserStatusWidget",
  component: BrowserStatusSidebarWidget,
  tags: ["autodocs"],
  args: { events: [], clearEvents: () => {} },
} satisfies Meta<typeof BrowserStatusSidebarWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One active tab plus several backgrounded tabs. */
export const Populated: Story = {
  decorators: withTabs([
    tab({
      id: "tab-1",
      title: "Pull request #9304 · elizaOS/eliza",
      url: "https://github.com/elizaOS/eliza/pull/9304",
      visible: true,
    }),
    tab({
      id: "tab-2",
      title: "Storybook",
      url: "https://localhost:6006",
    }),
    tab({
      id: "tab-3",
      url: "https://news.ycombinator.com",
    }),
  ]),
};

/** A single active tab — the smallest non-empty render. */
export const SingleTab: Story = {
  decorators: withTabs([
    tab({
      id: "only",
      title: "Eliza Cloud — Dashboard",
      url: "https://elizacloud.ai/dashboard",
      visible: true,
    }),
  ]),
};

/** A tab without a title falls back to the hostname. */
export const UntitledTab: Story = {
  decorators: withTabs([
    tab({
      id: "u1",
      title: "",
      url: "https://www.example.org/path",
      visible: true,
    }),
    tab({ id: "u2", title: "", url: "" }),
  ]),
};

/** Long titles must truncate cleanly between the dot and the status label. */
export const LongTitles: Story = {
  decorators: withTabs([
    tab({
      id: "long-1",
      title:
        "Extremely Long Documentation Page Title That Describes Every Configuration Option In Exhaustive Detail",
      url: "https://docs.example.com/configuration/reference/all-options",
      visible: true,
    }),
    tab({
      id: "long-2",
      title:
        "Another verbose tab heading that should be clipped before it pushes the Background status label off the row",
      url: "https://example.com/very/long/path/segment/here",
    }),
  ]),
};

/** Non-ASCII titles must render without mojibake. */
export const UnicodeTitles: Story = {
  decorators: withTabs([
    tab({
      id: "u1",
      title: "ニュース速報 📰",
      url: "https://news.example.jp",
      visible: true,
    }),
    tab({
      id: "u2",
      title: "آخر الأخبار 🌍",
      url: "https://news.example.sa",
    }),
  ]),
};

/** More tabs than the 8-row cap — only the first eight render. */
export const ManyTabs: Story = {
  decorators: withTabs(
    Array.from({ length: 12 }, (_, i) =>
      tab({
        id: `m${i}`,
        title: `Workspace tab ${i + 1}`,
        url: `https://example.com/tab/${i + 1}`,
        visible: i === 0,
      }),
    ),
  ),
};
