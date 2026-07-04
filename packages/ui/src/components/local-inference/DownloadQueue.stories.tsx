/** Storybook stories for DownloadQueue — single-downloading, empty, queued-and-downloading, failed-job, and unknown-model states. */

import type { Meta, StoryObj } from "@storybook/react";
import type {
  CatalogModel,
  DownloadJob,
} from "../../api/client-local-inference";
import { TranslationProvider } from "../../state/TranslationProvider";
import { DownloadQueue } from "./DownloadQueue";

function makeJob(overrides: Partial<DownloadJob> = {}): DownloadJob {
  const now = new Date().toISOString();
  return {
    jobId: "job-1",
    modelId: "eliza-1-2b",
    state: "downloading",
    received: 1_200_000_000,
    total: 2_400_000_000,
    bytesPerSec: 14_500_000,
    etaMs: 82_000,
    startedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const catalog: CatalogModel[] = [
  {
    id: "eliza-1-2b",
    displayName: "eliza-1-2b",
    hfRepo: "elizaos/eliza-1",
    ggufFile: "eliza-1-2b.gguf",
    params: "2B",
    quant: "Q4_K_M",
    sizeGb: 2.4,
    minRamGb: 6,
    category: "general",
    bucket: "mid",
    blurb: "Balanced mid-tier model",
  } as CatalogModel,
  {
    id: "eliza-1-9b",
    displayName: "eliza-1-9b",
    hfRepo: "elizaos/eliza-1",
    ggufFile: "eliza-1-9b.gguf",
    params: "9B",
    quant: "Q4_K_M",
    sizeGb: 6.1,
    minRamGb: 16,
    category: "general",
    bucket: "large",
    blurb: "High quality tier",
  } as CatalogModel,
];

const meta = {
  title: "LocalInference/DownloadQueue",
  component: DownloadQueue,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    downloads: [makeJob()],
    catalog,
    onCancel: () => {},
  },
  argTypes: {
    onCancel: { action: "cancel" },
  },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="w-[640px]">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof DownloadQueue>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleDownloading: Story = {};

export const Empty: Story = {
  args: {
    downloads: [],
  },
};

export const QueuedAndDownloading: Story = {
  args: {
    downloads: [
      makeJob({
        jobId: "job-1",
        modelId: "eliza-1-2b",
        state: "downloading",
        received: 800_000_000,
        total: 2_400_000_000,
      }),
      makeJob({
        jobId: "job-2",
        modelId: "eliza-1-9b",
        state: "queued",
        received: 0,
        total: 6_100_000_000,
        bytesPerSec: 0,
        etaMs: null,
      }),
    ],
  },
};

export const FailedJob: Story = {
  args: {
    downloads: [
      makeJob({
        jobId: "job-3",
        modelId: "eliza-1-9b",
        state: "failed",
        received: 1_500_000_000,
        bytesPerSec: 0,
        etaMs: null,
        error: "Network disconnected after 1.5 GB. Retry to resume.",
      }),
    ],
  },
};

export const UnknownModelId: Story = {
  args: {
    downloads: [
      makeJob({
        jobId: "job-4",
        modelId: "external-hf-unknown-abc123",
        state: "downloading",
        received: 200_000_000,
        total: 1_000_000_000,
      }),
    ],
  },
};
