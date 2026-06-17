import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { BrowserWorkspaceView } from "./BrowserWorkspaceView";

// BrowserWorkspaceView takes no props. It reads `plugins`, `walletAddresses`,
// and `walletConfig` from useApp() (the mock-app proxy supplies no-ops for the
// rest) and fetches the browser-workspace snapshot on mount. Storybook has no
// backend, so that fetch rejects and the view settles into its loading/empty
// state — a valid, useful render. The one hard requirement is that `plugins`
// is an array, since the component calls `.some()` / `.find()` on it during
// render; the proxy's default no-op would throw, so every story sets it.

const meta = {
  title: "Pages/BrowserWorkspaceView",
  component: BrowserWorkspaceView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [mockApp({ plugins: [] })],
} satisfies Meta<typeof BrowserWorkspaceView>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default: no browser-bridge plugin installed and no backend, so the view
 * renders its empty workspace chrome with the new-tab affordance.
 */
export const Default: Story = {};

/**
 * Browser-bridge plugin present. The bridge availability poll runs against the
 * (absent) backend, so the bridge UI shows its loading/disconnected state.
 */
export const WithBrowserBridgePlugin: Story = {
  decorators: [
    mockApp({
      plugins: [
        {
          id: "@elizaos/plugin-browser",
          name: "browser",
          npmName: "@elizaos/plugin-browser",
        },
      ],
    }),
  ],
};

/**
 * A wallet is connected via app context. The view seeds its initial wallet
 * state from these values before the (failing) steward-status refresh.
 */
export const WithConnectedWallet: Story = {
  decorators: [
    mockApp({
      plugins: [],
      walletAddresses: {
        evmAddress: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
        solanaAddress: "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV",
      },
      walletConfig: {
        evmAddress: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
        evmSigningCapability: "local",
        executionReady: true,
        solanaAddress: "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV",
        solanaSigningAvailable: true,
      },
    }),
  ],
};
