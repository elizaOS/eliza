import type { Meta, StoryObj } from "@storybook/react";
import type { DownloadJob } from "../../api/client-local-inference";
import { TranslationProvider } from "../../state/TranslationContext";
import { DownloadProgress } from "./DownloadProgress";

function makeJob(overrides: Partial<DownloadJob> = {}): DownloadJob {
  const now = new Date().toISOString();
  return {
    jobId: "job-1",
    modelId: "eliza-1-0_8b",
    state: "downloading",
    received: 410_000_000,
    total: 820_000_000,
    bytesPerSec: 12_500_000,
    etaMs: 33_000,
    startedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const meta = {
  title: "LocalInference/DownloadProgress",
  component: DownloadProgress,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { job: makeJob() },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="w-96">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof DownloadProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Downloading: Story = {};

export const JustStarted: Story = {
  args: {
    job: makeJob({ received: 0, bytesPerSec: 0, etaMs: null }),
  },
};

export const NearlyDone: Story = {
  args: {
    job: makeJob({
      received: 800_000_000,
      bytesPerSec: 8_000_000,
      etaMs: 2_500,
    }),
  },
};

export const Completed: Story = {
  args: {
    job: makeJob({
      state: "completed",
      received: 820_000_000,
      bytesPerSec: 0,
      etaMs: null,
    }),
  },
};

export const UnknownTotal: Story = {
  args: {
    job: makeJob({ total: 0, etaMs: null }),
  },
};
