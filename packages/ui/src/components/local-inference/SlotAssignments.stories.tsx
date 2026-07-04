/** Storybook stories for SlotAssignments — all-auto, custom, single-model, unverified-bundle, and empty states. */

import type { Meta, StoryObj } from "@storybook/react";
import type {
  InstalledModel,
  ModelAssignments,
} from "../../api/client-local-inference";
import { TranslationProvider } from "../../state/TranslationProvider";
import { SlotAssignments } from "./SlotAssignments";

const now = new Date().toISOString();

const installed: InstalledModel[] = [
  {
    id: "eliza-1-2b",
    displayName: "Eliza-1 2B",
    path: "/models/eliza-1-2b.gguf",
    sizeBytes: 820_000_000,
    installedAt: now,
    lastUsedAt: now,
    source: "eliza-download",
    bundleVerifiedAt: now,
  },
  {
    id: "eliza-1-4b",
    displayName: "Eliza-1 4B",
    path: "/models/eliza-1-4b.gguf",
    sizeBytes: 2_400_000_000,
    installedAt: now,
    lastUsedAt: null,
    source: "eliza-download",
    bundleVerifiedAt: now,
  },
];

const unverifiedInstalled: InstalledModel[] = [
  {
    id: "eliza-1-2b",
    displayName: "Eliza-1 2B",
    path: "/models/eliza-1-2b.gguf",
    sizeBytes: 820_000_000,
    installedAt: now,
    lastUsedAt: null,
    source: "eliza-download",
  },
];

const autoAssignments: ModelAssignments = {};

const customAssignments: ModelAssignments = {
  TEXT_SMALL: "eliza-1-2b",
  TEXT_LARGE: "eliza-1-4b",
  TEXT_TO_SPEECH: "eliza-1-2b",
};

const meta = {
  title: "LocalInference/SlotAssignments",
  component: SlotAssignments,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    installed,
    assignments: autoAssignments,
    onChange: () => {},
  },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="max-w-3xl">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof SlotAssignments>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default: all slots fall through to the auto-selected model. */
export const AllAuto: Story = {};

/** Each slot has been pinned to a specific installed model. */
export const CustomAssignments: Story = {
  args: { assignments: customAssignments },
};

/** Only the Eliza-1 2B model is installed — every slot can pick just it or auto. */
export const SingleModelInstalled: Story = {
  args: {
    installed: [installed[0]],
    assignments: { TEXT_LARGE: "eliza-1-2b" },
  },
};

/** Registered but unverified bundles stay hidden until native verification passes. */
export const UnverifiedBundle: Story = {
  args: {
    installed: unverifiedInstalled,
    assignments: {},
  },
};

/** No models installed — the component shows the empty-state hint. */
export const Empty: Story = {
  args: {
    installed: [],
    assignments: {},
  },
};
