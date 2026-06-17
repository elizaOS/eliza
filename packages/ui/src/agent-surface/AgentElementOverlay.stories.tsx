import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useRef } from "react";
import { AgentElementOverlay } from "./AgentElementOverlay";
import { AgentSurfaceProvider } from "./AgentSurfaceContext";
import { getViewRegistry } from "./registry";
import type { AgentElementDescriptor, AgentViewType } from "./types";

/**
 * The overlay draws labelled indicators over agent-addressable elements while a
 * view's registry has highlight mode on. These stories mount a small mock view,
 * register a few elements that point at real DOM nodes, then flip highlight so
 * the boxes render. Indicators portal into document.body and read live bounds.
 */

interface MockField {
  id: string;
  label: string;
  descriptor: Omit<AgentElementDescriptor, "label"> & { label: string };
  focused?: boolean;
}

const FIELDS: MockField[] = [
  {
    id: "send.amount",
    label: "Amount",
    descriptor: { id: "send.amount", role: "number-input", label: "Amount" },
    focused: true,
  },
  {
    id: "send.recipient",
    label: "Recipient",
    descriptor: {
      id: "send.recipient",
      role: "text-input",
      label: "Recipient",
    },
  },
  {
    id: "send.submit",
    label: "Send",
    descriptor: { id: "send.submit", role: "button", label: "Send" },
  },
];

function MockView({
  viewId,
  highlight,
}: {
  viewId: string;
  highlight: boolean;
}) {
  const refs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    const viewType: AgentViewType = "gui";
    const registry = getViewRegistry(viewId, viewType);
    if (!registry) return;
    const cleanups = FIELDS.map((field) =>
      registry.register(field.descriptor, () => refs.current[field.id] ?? null),
    );
    registry.setHighlight(highlight);
    // Bump so the overlay re-measures the now-mounted DOM nodes.
    registry.touch();
    return () => {
      for (const cleanup of cleanups) cleanup();
      registry.setHighlight(false);
    };
  }, [viewId, highlight]);

  return (
    <div className="max-w-sm space-y-3 p-6">
      <h3 className="text-sm font-semibold">Send funds</h3>
      <input
        ref={(el) => {
          refs.current["send.amount"] = el;
        }}
        defaultValue="25.00"
        placeholder="0.00"
        className="w-full rounded border px-3 py-2 text-sm"
      />
      <input
        ref={(el) => {
          refs.current["send.recipient"] = el;
        }}
        defaultValue="alice.eth"
        placeholder="address"
        className="w-full rounded border px-3 py-2 text-sm"
      />
      <button
        type="button"
        ref={(el) => {
          refs.current["send.submit"] = el;
        }}
        className="rounded bg-orange-500 px-4 py-2 text-sm text-white"
      >
        Send
      </button>
      <AgentElementOverlay />
    </div>
  );
}

const meta = {
  title: "AgentSurface/AgentElementOverlay",
  component: AgentElementOverlay,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AgentElementOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Highlight on: dashed indicators over every registered element. */
export const Highlighting: Story = {
  render: () => (
    <AgentSurfaceProvider viewId="story-overlay-on" viewType="gui">
      <MockView viewId="story-overlay-on" highlight />
    </AgentSurfaceProvider>
  ),
};

/** Highlight off: the overlay renders nothing (returns null). */
export const Idle: Story = {
  render: () => (
    <AgentSurfaceProvider viewId="story-overlay-off" viewType="gui">
      <MockView viewId="story-overlay-off" highlight={false} />
    </AgentSurfaceProvider>
  ),
};

/** Rendered with no surrounding AgentSurfaceProvider — no registry, renders nothing. */
export const NoSurface: Story = {
  render: () => <AgentElementOverlay />,
};
