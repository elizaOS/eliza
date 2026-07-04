/**
 * Storybook stories for the themed Sonner toaster.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { toast } from "sonner";
import { Toaster } from "./sonner";
import { ThemeProvider } from "./theme/theme-provider";

const meta = {
  title: "CloudUI/Sonner",
  component: Toaster,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <ThemeProvider defaultTheme="dark" enableSystem={false}>
        <div
          style={{ padding: 32, display: "flex", gap: 12, flexWrap: "wrap" }}
        >
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
  argTypes: {
    position: {
      control: "select",
      options: [
        "top-left",
        "top-center",
        "top-right",
        "bottom-left",
        "bottom-center",
        "bottom-right",
      ],
    },
    richColors: { control: "boolean" },
    closeButton: { control: "boolean" },
  },
  args: {
    position: "bottom-right",
    richColors: false,
    closeButton: false,
  },
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

const TriggerButton = ({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      padding: "8px 14px",
      borderRadius: 8,
      border: "1px solid var(--border, #2a2a2a)",
      background: "var(--popover, #111)",
      color: "var(--popover-foreground, #fafafa)",
      cursor: "pointer",
      fontSize: 13,
    }}
  >
    {label}
  </button>
);

export const Default: Story = {
  render: (args) => (
    <>
      <TriggerButton
        label="Show toast"
        onClick={() => toast("Deployment queued.")}
      />
      <Toaster {...args} />
    </>
  ),
};

export const Variants: Story = {
  render: (args) => (
    <>
      <TriggerButton
        label="Success"
        onClick={() => toast.success("Agent deployed successfully.")}
      />
      <TriggerButton
        label="Error"
        onClick={() => toast.error("Failed to reach the runtime.")}
      />
      <TriggerButton
        label="Info"
        onClick={() => toast.info("New model version available.")}
      />
      <TriggerButton
        label="Warning"
        onClick={() => toast.warning("API key expires in 7 days.")}
      />
      <Toaster {...args} />
    </>
  ),
};

export const WithDescription: Story = {
  render: (args) => (
    <>
      <TriggerButton
        label="Show detailed toast"
        onClick={() =>
          toast("Build complete", {
            description: "Bundle size 412 KB - 2.4s elapsed.",
          })
        }
      />
      <Toaster {...args} />
    </>
  ),
};

export const WithAction: Story = {
  render: (args) => (
    <>
      <TriggerButton
        label="Show action toast"
        onClick={() =>
          toast("Agent paused.", {
            description: "Outbound traffic is currently blocked.",
            action: {
              label: "Resume",
              onClick: () => {
                /* no-op for storybook */
              },
            },
          })
        }
      />
      <Toaster {...args} />
    </>
  ),
};

export const RichColorsTopCenter: Story = {
  args: {
    position: "top-center",
    richColors: true,
    closeButton: true,
  },
  render: (args) => (
    <>
      <TriggerButton
        label="Success (rich)"
        onClick={() => toast.success("Saved your changes.")}
      />
      <TriggerButton
        label="Error (rich)"
        onClick={() => toast.error("Something went wrong.")}
      />
      <Toaster {...args} />
    </>
  ),
};
