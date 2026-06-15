import type { Meta, StoryObj } from "@storybook/react";
import type { HardwareProbe } from "../../api/client-local-inference";
import { TranslationProvider } from "../../state/TranslationProvider";
import { HardwareBadge } from "./HardwareBadge";

function makeProbe(overrides: Partial<HardwareProbe> = {}): HardwareProbe {
  return {
    totalRamGb: 32,
    freeRamGb: 18,
    gpu: {
      backend: "metal",
      totalVramGb: 32,
      freeVramGb: 24,
    },
    cpuCores: 12,
    platform: "darwin",
    arch: "arm64",
    appleSilicon: true,
    recommendedBucket: "large",
    source: "capacitor-llama",
    ...overrides,
  };
}

const meta = {
  title: "LocalInference/HardwareBadge",
  component: HardwareBadge,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { hardware: makeProbe() },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="max-w-xl">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof HardwareBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AppleSiliconMetal: Story = {};

export const CudaWorkstation: Story = {
  args: {
    hardware: makeProbe({
      totalRamGb: 64,
      freeRamGb: 40,
      gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 20 },
      cpuCores: 16,
      platform: "linux",
      arch: "x64",
      appleSilicon: false,
      recommendedBucket: "xl",
    }),
  },
};

export const CpuOnlyLaptop: Story = {
  args: {
    hardware: makeProbe({
      totalRamGb: 8,
      freeRamGb: 3,
      gpu: null,
      cpuCores: 4,
      platform: "win32",
      arch: "x64",
      appleSilicon: false,
      recommendedBucket: "small",
    }),
  },
};

export const VulkanMidTier: Story = {
  args: {
    hardware: makeProbe({
      totalRamGb: 16,
      freeRamGb: 9,
      gpu: { backend: "vulkan", totalVramGb: 8, freeVramGb: 6 },
      cpuCores: 8,
      platform: "linux",
      arch: "x64",
      appleSilicon: false,
      recommendedBucket: "mid",
    }),
  },
};

export const OsFallbackWarning: Story = {
  args: {
    hardware: makeProbe({
      gpu: null,
      source: "os-fallback",
      recommendedBucket: "small",
    }),
  },
};
