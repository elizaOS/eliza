import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { ConfigPageView } from "./ConfigPageView";

const populatedWalletConfig = {
  selectedRpcProviders: {
    evm: "alchemy",
    bsc: "ankr",
    solana: "helius-birdeye",
  },
  alchemyKeySet: true,
  infuraKeySet: false,
  ankrKeySet: true,
  nodeRealBscRpcSet: false,
  quickNodeBscRpcSet: false,
  heliusKeySet: true,
  birdeyeKeySet: false,
  legacyCustomChains: [],
} as never;

const meta = {
  title: "Pages/ConfigPageView",
  component: ConfigPageView,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    mockApp({ elizaCloudConnected: true, walletConfig: null as never }),
  ],
  args: {
    embedded: false,
    onWalletSaveSuccess: () => {},
  },
} satisfies Meta<typeof ConfigPageView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Cloud mode with an active Eliza Cloud connection (default). */
export const CloudConnected: Story = {};

/** Cloud mode, signed out — prompts the user to connect to Eliza Cloud. */
export const CloudSignedOut: Story = {
  decorators: [
    mockApp({ elizaCloudConnected: false, walletConfig: null as never }),
  ],
};

/** Cloud login in progress, with the browser-window fallback link visible. */
export const CloudConnecting: Story = {
  decorators: [
    mockApp({
      elizaCloudConnected: false,
      elizaCloudLoginBusy: true,
      elizaCloudLoginFallbackUrl: "https://cloud.eliza.how/login?token=abc123",
      walletConfig: null as never,
    }),
  ],
};

/**
 * Custom RPC mode driven by a populated wallet config (Alchemy / Ankr / Helius
 * selected). Because the config selects non-cloud providers, the view opens on
 * the custom-providers panel.
 */
export const CustomProviders: Story = {
  decorators: [
    mockApp({
      elizaCloudConnected: false,
      walletConfig: populatedWalletConfig,
    }),
  ],
};

/** Saving state — the Save button shows its busy label and is disabled. */
export const Saving: Story = {
  decorators: [
    mockApp({
      elizaCloudConnected: true,
      walletApiKeySaving: true,
      walletConfig: null as never,
    }),
  ],
};

/** Embedded variant — no page header, used when hosted inside another panel. */
export const Embedded: Story = {
  args: { embedded: true },
};
