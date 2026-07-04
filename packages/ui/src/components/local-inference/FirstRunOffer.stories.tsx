/** Storybook stories for FirstRunOffer — needs-download, in-progress, default-enqueued, no-recommendation, and hidden-when-satisfied states. */

import type { Meta, StoryObj } from "@storybook/react";
import type {
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
} from "../../api/client-local-inference";
import { TranslationProvider } from "../../state/TranslationProvider";
import { FirstRunOffer } from "./FirstRunOffer";

const hardware: HardwareProbe = {
  totalRamGb: 32,
  freeRamGb: 18,
  gpu: { backend: "metal", totalVramGb: 16, freeVramGb: 12 },
  cpuCores: 10,
  platform: "darwin",
  arch: "arm64",
  appleSilicon: true,
  recommendedBucket: "medium",
  source: "os-fallback",
};

const catalog: CatalogModel[] = [
  {
    id: "eliza-1-2b",
    displayName: "Eliza-1 2B",
    hfRepo: "elizaos/eliza-1",
    ggufFile: "eliza-1-2b.gguf",
    params: "2B",
    quant: "Q4_K_M",
    sizeGb: 1.4,
    minRamGb: 4,
    category: "text",
    bucket: "small",
    blurb: "Compact local chat model — runs comfortably on most laptops.",
  },
  {
    id: "eliza-1-2b",
    displayName: "Eliza-1 2B",
    hfRepo: "elizaos/eliza-1",
    ggufFile: "eliza-1-2b.gguf",
    params: "2B",
    quant: "Q4_K_M",
    sizeGb: 2.0,
    minRamGb: 8,
    category: "text",
    bucket: "medium",
    blurb: "Default local chat model — better reasoning, still fast.",
  },
];

const now = new Date().toISOString();

const elizaInstalled: InstalledModel = {
  id: "eliza-1-2b",
  displayName: "Eliza-1 2B",
  path: "/models/eliza-1-2b.gguf",
  sizeBytes: 2_000_000_000,
  installedAt: now,
  lastUsedAt: now,
  source: "eliza-download",
};

const activeDownload: DownloadJob = {
  jobId: "job-1",
  modelId: "eliza-1-2b",
  state: "downloading",
  received: 800_000_000,
  total: 2_000_000_000,
  bytesPerSec: 10_000_000,
  etaMs: 120_000,
  startedAt: now,
  updatedAt: now,
};

const meta = {
  title: "LocalInference/FirstRunOffer",
  component: FirstRunOffer,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    busy: { control: "boolean" },
  },
  args: {
    catalog,
    installed: [],
    downloads: [],
    hardware,
    busy: false,
    onDownload: () => {},
  },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="w-[36rem] max-w-full">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof FirstRunOffer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No Eliza model installed yet — offers the recommended default download. */
export const NeedsDownload: Story = {};

/** A user-side download is mid-flight; the offer reflects the in-progress state. */
export const DownloadInProgress: Story = {
  args: {
    installed: [],
    downloads: [activeDownload],
  },
};

/** Default model already enqueued — button shows downloading-default state and is disabled. */
export const DefaultEnqueued: Story = {
  args: {
    installed: [],
    downloads: [{ ...activeDownload, state: "queued" }],
    busy: true,
  },
};

/** Empty catalog — no recommendation can be made, so no download button. */
export const NoRecommendation: Story = {
  args: {
    catalog: [],
    installed: [],
    downloads: [],
  },
};

/**
 * An Eliza-owned model is already installed AND no active downloads —
 * the offer hides itself (component returns null).
 */
export const HiddenWhenSatisfied: Story = {
  args: {
    installed: [elizaInstalled],
    downloads: [],
  },
};
