import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import type { ChatSidebarVisibilityHook } from "../../widgets/useChatSidebarVisibility";
import type { VisibilityCandidate } from "../../widgets/visibility";
import {
  type WidgetVisibilityCandidate,
  WidgetVisibilityEditor,
} from "./WidgetVisibilityPanel";

function ClockIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="4" cy="6" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="18" r="1" />
    </svg>
  );
}

const sampleCandidates: WidgetVisibilityCandidate[] = [
  {
    pluginId: "app-core",
    id: "tasks",
    label: "Tasks",
    defaultEnabled: true,
    icon: <ListIcon />,
  },
  {
    pluginId: "app-core",
    id: "events",
    label: "Upcoming events",
    defaultEnabled: true,
    icon: <ClockIcon />,
  },
  {
    pluginId: "plugin-wallet",
    id: "balance",
    label: "Wallet balance",
    defaultEnabled: true,
  },
  {
    pluginId: "plugin-feed",
    id: "trending",
    label: "Trending feed",
    defaultEnabled: false,
  },
];

function useMockVisibility(
  initial: Record<string, boolean> = {},
): ChatSidebarVisibilityHook {
  const [overrides, setOverrides] = useState(initial);
  return {
    overrides,
    isVisible(candidate: VisibilityCandidate) {
      const key = `${candidate.pluginId}/${candidate.id}`;
      if (Object.hasOwn(overrides, key)) return overrides[key] === true;
      return candidate.defaultEnabled !== false;
    },
    setVisible(candidate, next) {
      const key = `${candidate.pluginId}/${candidate.id}`;
      const defaultEnabled = candidate.defaultEnabled !== false;
      setOverrides((prev) => {
        const nextOverrides = { ...prev };
        if (next === defaultEnabled) delete nextOverrides[key];
        else nextOverrides[key] = next;
        return nextOverrides;
      });
    },
    reset() {
      setOverrides({});
    },
  };
}

interface HarnessProps {
  candidates: readonly WidgetVisibilityCandidate[];
  initialOverrides?: Record<string, boolean>;
  onClose: () => void;
}

function EditorHarness({
  candidates,
  initialOverrides,
  onClose,
}: HarnessProps) {
  const visibility = useMockVisibility(initialOverrides);
  return (
    <div className="flex h-[520px] w-[320px] flex-col rounded-md border border-border bg-bg">
      <WidgetVisibilityEditor
        candidates={candidates}
        visibility={visibility}
        onClose={onClose}
      />
    </div>
  );
}

const meta = {
  title: "Chat/WidgetVisibilityPanel",
  component: EditorHarness,
  tags: ["autodocs"],
  args: {
    candidates: sampleCandidates,
    onClose: () => {},
  },
} satisfies Meta<typeof EditorHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    candidates: [],
  },
};

export const WithOverrides: Story = {
  args: {
    initialOverrides: {
      "app-core/events": false,
      "plugin-feed/trending": true,
    },
  },
};

export const SingleCandidate: Story = {
  args: {
    candidates: [
      {
        pluginId: "app-core",
        id: "tasks",
        label: "Tasks",
        defaultEnabled: true,
        icon: <ListIcon />,
      },
    ],
  },
};
