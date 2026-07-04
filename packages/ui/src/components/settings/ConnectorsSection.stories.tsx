/** Storybook fixtures for `ConnectorsSection`: default list, single/all-disabled connectors, a validation-error row, and the empty state. */

import type { Meta, StoryObj } from "@storybook/react";
import type { PluginInfo } from "../../api";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { ConnectorsSection } from "./ConnectorsSection";

function connector(
  overrides: Partial<PluginInfo> & Pick<PluginInfo, "id" | "name">,
): PluginInfo {
  return {
    description: `${overrides.name} connector`,
    enabled: true,
    configured: true,
    envKey: null,
    category: "connector",
    source: "bundled",
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    ...overrides,
  };
}

const populatedPlugins: PluginInfo[] = [
  connector({
    id: "telegram",
    name: "Telegram",
    enabled: true,
    configured: true,
  }),
  connector({
    id: "discord",
    name: "Discord",
    enabled: false,
    configured: false,
  }),
  connector({
    id: "signal",
    name: "Signal",
    enabled: true,
    configured: false,
    validationErrors: [
      { field: "phoneNumber", message: "Phone number is required" },
    ],
  }),
  connector({
    id: "whatsapp",
    name: "WhatsApp",
    enabled: true,
    configured: true,
  }),
  // Non-connector category — should be filtered out of the section.
  connector({ id: "openai", name: "OpenAI", category: "ai-provider" }),
];

const meta = {
  title: "Settings/ConnectorsSection",
  component: ConnectorsSection,
  tags: ["autodocs"],
  decorators: [mockApp({ plugins: populatedPlugins })],
  parameters: { layout: "padded" },
} satisfies Meta<typeof ConnectorsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Several connectors in mixed states: enabled+configured (green), disabled
 * (grey), enabled-but-misconfigured (warn). Rows are collapsed; expanding one
 * mounts that connector's own setup panel.
 */
export const Default: Story = {};

/** A single, healthy connector. */
export const SingleConnector: Story = {
  decorators: [
    mockApp({
      plugins: [
        connector({
          id: "telegram",
          name: "Telegram",
          enabled: true,
          configured: true,
        }),
      ],
    }),
  ],
};

/** Every connector toggled off — all status dots read as "off". */
export const AllDisabled: Story = {
  decorators: [
    mockApp({
      plugins: populatedPlugins.map((p) =>
        p.category === "connector" ? { ...p, enabled: false } : p,
      ),
    }),
  ],
};

/** A connector with validation errors — warn status dot. */
export const WithValidationError: Story = {
  decorators: [
    mockApp({
      plugins: [
        connector({
          id: "signal",
          name: "Signal",
          enabled: true,
          configured: false,
          validationErrors: [
            { field: "phoneNumber", message: "Phone number is required" },
          ],
        }),
      ],
    }),
  ],
};

/** No connector plugins available — renders the empty-state copy. */
export const Empty: Story = {
  decorators: [mockApp({ plugins: [] })],
};
