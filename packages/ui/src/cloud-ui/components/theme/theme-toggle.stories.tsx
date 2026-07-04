/**
 * Storybook stories for the ThemeToggle.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ThemeProvider } from "./theme-provider";
import { ThemeToggle } from "./theme-toggle";

const meta = {
  title: "CloudUI/Theme/ThemeToggle",
  component: ThemeToggle,
  tags: ["autodocs"],
  decorators: [
    (Story, context) => {
      const defaultTheme =
        (context.parameters.defaultTheme as
          | "light"
          | "dark"
          | "system"
          | undefined) ?? "light";
      return (
        <ThemeProvider
          defaultTheme={defaultTheme}
          enableSystem={false}
          storageKey={`storybook-theme-${context.id}`}
        >
          <div className="flex items-center justify-center rounded-md border border-border bg-background p-8 text-foreground">
            <Story />
          </div>
        </ThemeProvider>
      );
    },
  ],
} satisfies Meta<typeof ThemeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LightDefault: Story = {
  parameters: { defaultTheme: "light" },
};

export const DarkDefault: Story = {
  parameters: { defaultTheme: "dark" },
};

export const InToolbar: Story = {
  parameters: { defaultTheme: "light" },
  decorators: [
    (Story) => (
      <div className="flex w-full items-center justify-between gap-4 rounded-md border border-border bg-card px-4 py-2">
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-foreground">
            Dashboard
          </span>
          <span className="text-xs text-muted-foreground">
            Adjust appearance for your workspace
          </span>
        </div>
        <Story />
      </div>
    ),
  ],
};

export const SystemDefault: Story = {
  parameters: { defaultTheme: "system" },
};
