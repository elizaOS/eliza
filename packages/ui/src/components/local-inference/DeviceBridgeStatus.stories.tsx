/** Storybook stories for DeviceBridgeStatusBar — connected, offline-pending, no-device, and null states. */

import type { Meta, StoryObj } from "@storybook/react";
import type { DeviceBridgeStatus } from "../../api/client-local-inference";
import { TranslationProvider } from "../../state/TranslationProvider";
import { DeviceBridgeStatusBar } from "./DeviceBridgeStatus";

const baseConnectedSince = new Date("2026-06-05T10:00:00Z").toISOString();

const connectedStatus: DeviceBridgeStatus = {
  connected: true,
  devices: [
    {
      deviceId: "device-1",
      capabilities: {
        platform: "ios",
        deviceModel: "iPhone 17 Pro",
        totalRamGb: 8,
        cpuCores: 6,
        gpu: { backend: "metal", available: true, totalVramGb: 4 },
      },
      loadedPath: "/models/eliza-1-2b.gguf",
      connectedSince: baseConnectedSince,
      score: 100,
      activeRequests: 0,
      isPrimary: true,
    },
  ],
  primaryDeviceId: "device-1",
  pendingRequests: 0,
  deviceId: "device-1",
  capabilities: {
    platform: "ios",
    deviceModel: "iPhone 17 Pro",
    totalRamGb: 8,
    cpuCores: 6,
    gpu: { backend: "metal", available: true, totalVramGb: 4 },
  },
  loadedPath: "/models/eliza-1-2b.gguf",
  connectedSince: baseConnectedSince,
};

const offlinePendingStatus: DeviceBridgeStatus = {
  connected: false,
  devices: [],
  primaryDeviceId: null,
  pendingRequests: 3,
  deviceId: null,
  capabilities: null,
  loadedPath: null,
  connectedSince: null,
};

const noDeviceStatus: DeviceBridgeStatus = {
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
  title: "LocalInference/DeviceBridgeStatus",
  component: DeviceBridgeStatusBar,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { status: connectedStatus },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="w-96">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof DeviceBridgeStatusBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Paired device online with capabilities and a loaded model path. */
export const Connected: Story = {};

/** Connected but no capabilities reported — falls back to the generic online label. */
export const ConnectedNoCapabilities: Story = {
  args: {
    status: {
      ...connectedStatus,
      capabilities: null,
      loadedPath: null,
    },
  },
};

/** Device offline with requests queued — amber indicator. */
export const OfflineWithPendingRequests: Story = {
  args: { status: offlinePendingStatus },
};

/** No device has ever been paired. */
export const NoPairedDevice: Story = {
  args: { status: noDeviceStatus },
};

/** When status is null the bar renders nothing. */
export const NullStatus: Story = {
  args: { status: null },
};
