/**
 * Storybook story for ProviderPicker — the command-palette provider chooser
 * in the Add Account dialog. Renders under the shared MockAppProvider.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { MockAppProvider } from "../../storybook/mock-providers";
import { ProviderPicker } from "./ProviderPicker";

const meta = {
  title: "Accounts/ProviderPicker",
  component: ProviderPicker,
  decorators: [
    (Story) => (
      <MockAppProvider>
        <div className="max-w-md bg-bg p-4">
          <Story />
        </div>
      </MockAppProvider>
    ),
  ],
  args: {
    onPick: () => {},
  },
} satisfies Meta<typeof ProviderPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
