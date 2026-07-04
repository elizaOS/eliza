/** Storybook stories for DevicesPanel — multi-device, single CPU-only, and empty/null states. */

import type { Meta, StoryObj } from "@storybook/react";
import type { DeviceBridgeStatus } from "../../api/client-local-inference";
import { TranslationProvider } from "../../state/TranslationProvider";
import { DevicesPanel } from "./DevicesPanel";

const connectedSince = new Date("2026-06-05T10:00:00Z").toISOString();

const desktopAndPhone: DeviceBridgeStatus = {
  connected: true,
  devices: [
    {
      deviceId: "device-mac",
      capabilities: {
        platform: "desktop",
        deviceModel: "MacBook Pro M4 Max",
        totalRamGb: 64,
        cpuCores: 16,
        gpu: { backend: "metal", available: true, totalVramGb: 48 },
      },
      loadedPath: "/models/eliza-1-2b.gguf",
      connectedSince,
      score: 372,
      activeRequests: 2,
      isPrimary: true,
    },
    {
      deviceId: "device-iphone",
      capabilities: {
        platform: "ios",
        deviceModel: "iPhone 17 Pro",
        totalRamGb: 8,
        cpuCores: 6,
        gpu: { backend: "metal", available: true, totalVramGb: 4 },
      },
      loadedPath: null,
      connectedSince,
      score: 46,
      activeRequests: 0,
      isPrimary: false,
    },
  ],
  primaryDeviceId: "device-mac",
  pendingRequests: 2,
  deviceId: "device-mac",
  capabilities: null,
  loadedPath: "/models/eliza-1-2b.gguf",
  connectedSince,
};

const singleCpuOnly: DeviceBridgeStatus = {
  connected: true,
  devices: [
    {
      deviceId: "device-pi",
      capabilities: {
        platform: "desktop",
        deviceModel: "Raspberry Pi 5",
        totalRamGb: 8,
        cpuCores: 4,
        gpu: null,
      },
      loadedPath: null,
      connectedSince,
      score: 116,
      activeRequests: 0,
      isPrimary: true,
    },
  ],
  primaryDeviceId: "device-pi",
  pendingRequests: 0,
  deviceId: "device-pi",
  capabilities: null,
  loadedPath: null,
  connectedSince,
};

const noDevices: DeviceBridgeStatus = {
  connected: false,
  devices: [],
  primaryDeviceId: null,
  pendingRequests: 0,
  deviceId: null,
  capabilities: null,
  loadedPath: null,
  connectedSince: null,
};

const meta = {
  title: "LocalInference/DevicesPanel",
  component: DevicesPanel,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { status: desktopAndPhone },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="w-[640px] max-w-full">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof DevicesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Primary desktop with a GPU, plus a phone fallback ranked below it. */
export const DesktopAndPhone: Story = {};

/** Single CPU-only device — shows the "CPU only" capability label. */
export const SingleCpuOnly: Story = {
  args: { status: singleCpuOnly },
};

/** No devices connected — the panel renders nothing. */
export const NoDevices: Story = {
  args: { status: noDevices },
};

/** Null status (e.g. before the first poll) — the panel renders nothing. */
export const NullStatus: Story = {
  args: { status: null },
};
