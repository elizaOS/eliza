/** Storybook stories for ModelCard — default, won't-fit, downloading, failed, installed, active, and download-unavailable states. */

import type { Meta, StoryObj } from "@storybook/react";
import type {
  ActiveModelState,
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
} from "../../api/client-local-inference";
import { TranslationProvider } from "../../state/TranslationProvider";
import { ModelCard } from "./ModelCard";

const model: CatalogModel = {
  id: "eliza-1-2b",
  displayName: "eliza-1-2b",
  hfRepo: "elizaos/eliza-1",
  ggufFile: "eliza-1-2b.gguf",
  params: "2B",
  parameterLabel: "2B",
  quant: "Q4_K_M",
  sizeGb: 2.4,
  minRamGb: 6,
  category: "chat",
  bucket: "mid",
  blurb:
    "Balanced mid-tier model. Good quality for general chat and coding tasks without taxing modest hardware.",
} as CatalogModel;

const beefyHardware: HardwareProbe = {
  totalRamGb: 32,
  freeRamGb: 24,
  gpu: { backend: "metal", totalVramGb: 16, freeVramGb: 12 },
  cpuCores: 10,
  platform: "darwin",
  arch: "arm64",
  appleSilicon: true,
  recommendedBucket: "large",
  source: "os-fallback",
};

const tinyHardware: HardwareProbe = {
  ...beefyHardware,
  totalRamGb: 4,
  freeRamGb: 2,
  gpu: null,
  recommendedBucket: "small",
};

const installedEntry: InstalledModel = {
  id: "eliza-1-2b",
  displayName: "eliza-1-2b",
  path: "/models/eliza-1-2b.gguf",
  sizeBytes: 2_400_000_000,
  installedAt: new Date().toISOString(),
  lastUsedAt: new Date().toISOString(),
  source: "eliza-download",
};

const downloadingJob: DownloadJob = {
  jobId: "job-1",
  modelId: "eliza-1-2b",
  state: "downloading",
  received: 1_200_000_000,
  total: 2_400_000_000,
  bytesPerSec: 14_500_000,
  etaMs: 82_000,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const failedJob: DownloadJob = {
  ...downloadingJob,
  state: "failed",
  error: "Network disconnected after 1.5 GB. Retry to resume.",
};

const idleActive: ActiveModelState = {
  modelId: null,
  loadedAt: null,
  status: "idle",
};

const meta = {
  title: "LocalInference/ModelCard",
  component: ModelCard,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    onDownload: { action: "download" },
    onCancel: { action: "cancel" },
    onActivate: { action: "activate" },
    onUninstall: { action: "uninstall" },
    onVerify: { action: "verify" },
    onRedownload: { action: "redownload" },
    busy: { control: "boolean" },
  },
  args: {
    model,
    hardware: beefyHardware,
    installed: [],
    downloads: [],
    active: idleActive,
    busy: false,
    onDownload: () => {},
    onCancel: () => {},
    onActivate: () => {},
    onUninstall: () => {},
  },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="w-[420px]">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof ModelCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Not installed, hardware fits — shows the Download CTA. */
export const Default: Story = {};

/** Hardware is too small for this model — Download disabled, fit pill is red. */
export const WontFit: Story = {
  args: { hardware: tinyHardware },
};

/** A download is in progress — progress bar + Cancel button replace Download. */
export const Downloading: Story = {
  args: { downloads: [downloadingJob] },
};

/** A previous download failed — error line + retry path through Download. */
export const DownloadFailed: Story = {
  args: { downloads: [failedJob] },
};

/** Model is installed but not active — Make active + Verify + Uninstall. */
export const Installed: Story = {
  args: {
    installed: [installedEntry],
    onVerify: () => {},
    onRedownload: () => {},
  },
};

/** Model is currently loaded as the active runtime — Active pill, no activate CTA. */
export const Active: Story = {
  args: {
    installed: [installedEntry],
    active: {
      modelId: "eliza-1-2b",
      loadedAt: new Date().toISOString(),
      status: "ready",
    },
    onVerify: () => {},
  },
};

/** Download is unavailable (e.g. offline) — button is disabled with reason. */
export const DownloadUnavailable: Story = {
  args: {
    downloadDisabledReason: "Offline — connect to the internet to download",
  },
};
