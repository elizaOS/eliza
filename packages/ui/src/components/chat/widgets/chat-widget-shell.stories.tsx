/** Expanded work-in-progress and collapsed completed chat-widget states. */
import type { Meta, StoryObj } from "@storybook/react";
import { CheckCircle2, Plug } from "lucide-react";
import { MockAppProvider } from "../../../storybook/mock-providers";
import { Input } from "../../ui/input";
import { ChatWidgetShell } from "./chat-widget-shell";

const meta = {
  title: "Chat/Widgets/ChatWidgetShell",
  component: ChatWidgetShell,
  parameters: { layout: "padded" },
  decorators: [
    // MockAppProvider seeds the useAppSelector store the shell reads `t` from.
    (Story) => (
      <MockAppProvider>
        <Story />
      </MockAppProvider>
    ),
  ],
  args: {
    title: "Connect Discord",
    icon: <Plug className="size-4" aria-hidden />,
    summary: "Discord is connected.",
    children: (
      <div className="space-y-2 py-2">
        <label htmlFor="discord-token" className="text-xs text-muted">
          Bot token
        </label>
        <Input id="discord-token" placeholder="Paste token" />
      </div>
    ),
  },
} satisfies Meta<typeof ChatWidgetShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InProgress: Story = { args: { complete: false } };

export const Complete: Story = {
  args: {
    complete: true,
    status: (
      <span className="inline-flex items-center gap-1 text-xs text-ok">
        <CheckCircle2 className="size-3.5" aria-hidden /> Connected
      </span>
    ),
  },
};
