import type { Meta, StoryObj } from "@storybook/react";
import type {
  ActiveModelState,
  HardwareProbe,
  InstalledModel,
} from "../../api/client-local-inference";
import { TranslationProvider } from "../../state/TranslationProvider";
import { CustomModelSearch } from "./CustomModelSearch";

const hardware: HardwareProbe = {
  totalRamGb: 64,
  freeRamGb: 48,
  gpu: null,
  cpuCores: 8,
  platform: "darwin",
  arch: "arm64",
  appleSilicon: true,
  recommendedBucket: "large",
  source: "os-fallback",
};

const idleActive: ActiveModelState = {
  modelId: null,
  loadedAt: null,
  status: "idle",
};

const installed: InstalledModel[] = [
  {
    id: "eliza-1-0_8b",
    displayName: "Eliza-1 0.8B",
    path: "/models/eliza-1-0_8b.gguf",
    sizeBytes: 820_000_000,
    installedAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    source: "eliza-download",
  },
];

const meta = {
  title: "LocalInference/CustomModelSearch",
  component: CustomModelSearch,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    installed: [],
    downloads: [],
    active: idleActive,
    hardware,
    onDownload: () => {},
    onCancel: () => {},
    onActivate: () => {},
    onUninstall: () => {},
    busy: false,
  },
  argTypes: {
    busy: { control: "boolean" },
  },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="max-w-4xl">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof CustomModelSearch>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default empty state — no query entered yet. The provider toggle and search
 * input are visible along with the explicit opt-in notice.
 */
export const Default: Story = {};

/**
 * Existing installed models are passed in; the search panel itself still
 * shows the same empty state until the user types a query.
 */
export const WithInstalledModels: Story = {
  args: {
    installed,
  },
};

/** While a parent action is in flight, all downstream buttons are disabled. */
export const Busy: Story = {
  args: {
    busy: true,
  },
};

/** A model is already active in the parent runtime. */
export const ActiveModelReady: Story = {
  args: {
    installed,
    active: {
      modelId: "eliza-1-0_8b",
      loadedAt: new Date().toISOString(),
      status: "ready",
    },
  },
};
