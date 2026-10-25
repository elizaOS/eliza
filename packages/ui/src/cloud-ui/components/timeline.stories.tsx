/**
 * Storybook stories for the scroll-driven Timeline.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Timeline } from "./timeline";

const meta = {
  title: "CloudUI/Timeline",
  component: Timeline,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    backgrounds: { default: "dark" },
  },
  decorators: [
    (Story) => (
      <div style={{ background: "#0a0a0a", minHeight: "100vh" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Timeline>;

export default meta;
type Story = StoryObj<typeof meta>;

const sampleData = [
  {
    title: "2024",
    content: (
      <div>
        <p className="text-neutral-200 text-sm md:text-base mb-4">
          Launched the new dashboard with real-time agent telemetry and a
          rebuilt plugin registry.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <img
            src="https://placehold.co/600x400/1a1a1a/ffffff?text=Dashboard"
            alt="Dashboard"
            className="rounded-lg w-full h-32 md:h-44 object-cover"
          />
          <img
            src="https://placehold.co/600x400/2a2a2a/ffffff?text=Registry"
            alt="Registry"
            className="rounded-lg w-full h-32 md:h-44 object-cover"
          />
        </div>
      </div>
    ),
  },
  {
    title: "2023",
    content: (
      <div>
        <p className="text-neutral-200 text-sm md:text-base mb-4">
          Released the agent runtime v1 and opened the framework to the
          community. Shipped the first batch of model plugins.
        </p>
        <ul className="list-disc pl-5 text-neutral-300 text-sm space-y-1">
          <li>Agent runtime v1 stable</li>
          <li>Model plugin SDK</li>
          <li>Voice + memory primitives</li>
        </ul>
      </div>
    ),
  },
  {
    title: "Early 2023",
    content: (
      <div>
        <p className="text-neutral-200 text-sm md:text-base mb-4">
          First commits — character files, the agent loop, and the action /
          provider / evaluator model started taking shape.
        </p>
        <img
          src="https://placehold.co/1200x400/3a3a3a/ffffff?text=Genesis"
          alt="Genesis"
          className="rounded-lg w-full h-40 md:h-56 object-cover"
        />
      </div>
    ),
  },
];

export const Default: Story = {
  args: {
    data: sampleData,
  },
};

export const CustomHeader: Story = {
  args: {
    title: "elizaOS release timeline",
    description:
      "A retrospective of the major milestones since the project began.",
    data: sampleData,
  },
};

export const SingleEntry: Story = {
  args: {
    title: "Launch day",
    description: "Just one entry — useful for stub states.",
    data: [
      {
        title: "Today",
        content: (
          <p className="text-neutral-200 text-sm md:text-base">
            The first public release is live. More entries will appear here as
            the project evolves.
          </p>
        ),
      },
    ],
  },
};

export const TextOnly: Story = {
  args: {
    title: "Changelog",
    description: "Plain text entries, no images.",
    data: [
      {
        title: "v0.3",
        content: (
          <p className="text-neutral-300 text-sm md:text-base">
            Added streaming responses and a new evaluator pipeline.
          </p>
        ),
      },
      {
        title: "v0.2",
        content: (
          <p className="text-neutral-300 text-sm md:text-base">
            Introduced the plugin model and the first three connectors.
          </p>
        ),
      },
      {
        title: "v0.1",
        content: (
          <p className="text-neutral-300 text-sm md:text-base">
            Initial release with the core agent loop.
          </p>
        ),
      },
    ],
  },
};
