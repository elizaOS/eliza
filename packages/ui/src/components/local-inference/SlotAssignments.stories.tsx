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
    id: "eliza-1-0_8b",
    displayName: "Eliza-1 0.8B",
    path: "/models/eliza-1-0_8b.gguf",
    sizeBytes: 820_000_000,
    installedAt: now,
    lastUsedAt: now,
    source: "eliza-download",
  },
  {
    id: "eliza-1-3b",
    displayName: "Eliza-1 3B",
    path: "/models/eliza-1-3b.gguf",
    sizeBytes: 3_100_000_000,
    installedAt: now,
    lastUsedAt: null,
    source: "eliza-download",
  },
  {
    id: "llama-3.1-8b-q4",
    displayName: "Llama 3.1 8B (Q4)",
    path: "/Users/me/.lmstudio/models/llama-3.1-8b-q4.gguf",
    sizeBytes: 4_700_000_000,
    installedAt: now,
    lastUsedAt: null,
    source: "external-scan",
    externalOrigin: "lm-studio",
  },
];

const autoAssignments: ModelAssignments = {};

const customAssignments: ModelAssignments = {
  TEXT_SMALL: "eliza-1-0_8b",
  TEXT_LARGE: "eliza-1-3b",
  TEXT_TO_SPEECH: "llama-3.1-8b-q4",
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

/** Only the Eliza-1 0.8B model is installed — every slot can pick just it or auto. */
export const SingleModelInstalled: Story = {
  args: {
    installed: [installed[0]],
    assignments: { TEXT_LARGE: "eliza-1-0_8b" },
  },
};

/** Includes a model discovered via external scan (LM Studio) to show the origin suffix. */
export const WithExternalScan: Story = {
  args: {
    installed,
    assignments: { TEXT_LARGE: "llama-3.1-8b-q4" },
  },
};

/** No models installed — the component shows the empty-state hint. */
export const Empty: Story = {
  args: {
    installed: [],
    assignments: {},
  },
};
