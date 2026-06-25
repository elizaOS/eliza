import type { Decorator, Meta, StoryObj } from "@storybook/react";
import {
  type MockAppOptions,
  MockAppProvider,
} from "../../storybook/mock-providers";
import { CustomActionsPanel } from "./CustomActionsPanel";

const mockAppValue = {
  t: (
    key: string,
    opts?: {
      defaultValue?: string;
      actionCount?: number;
      enabledCount?: number;
      count?: number;
      name?: string;
    },
  ) => {
    if (!opts?.defaultValue) return key;
    let value = opts.defaultValue;
    for (const [k, v] of Object.entries(opts)) {
      if (k === "defaultValue") continue;
      value = value.replaceAll(`{{${k}}}`, String(v));
    }
    return value;
  },
} satisfies MockAppOptions;

const withCustomActionsApi: Decorator = (Story) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/custom-actions")) {
      return new Response(JSON.stringify({ actions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return original(input, init);
  }) as typeof fetch;
  return <Story />;
};

const meta = {
  title: "CustomActions/CustomActionsPanel",
  component: CustomActionsPanel,
  tags: ["autodocs"],
  decorators: [
    withCustomActionsApi,
    (Story) => (
      <MockAppProvider value={mockAppValue}>
        <div className="flex h-[600px] bg-bg">
          <Story />
        </div>
      </MockAppProvider>
    ),
  ],
  argTypes: {
    open: { control: "boolean" },
  },
  args: {
    open: true,
    onClose: () => {},
    onOpenEditor: () => {},
  },
} satisfies Meta<typeof CustomActionsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const Closed: Story = {
  args: {
    open: false,
  },
};
