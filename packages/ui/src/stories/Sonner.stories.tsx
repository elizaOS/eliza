import type { Meta, StoryObj } from "@storybook/react";
import { type ReactNode, useEffect } from "react";
import { toast } from "sonner";
import { Toaster } from "../components/ui/sonner";

function DarkThemeStoryWrapper({ children }: { children: ReactNode }) {
  useEffect(() => {
    const root = document.documentElement;
    const previousTheme = root.getAttribute("data-theme");
    const previousDark = root.classList.contains("dark");

    root.setAttribute("data-theme", "dark");
    root.classList.add("dark");

    return () => {
      if (previousTheme) {
        root.setAttribute("data-theme", previousTheme);
      } else {
        root.removeAttribute("data-theme");
      }

      if (!previousDark) {
        root.classList.remove("dark");
      }
    };
  }, []);

  return <>{children}</>;
}

const meta = {
  title: "UI/Sonner",
  component: Toaster,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <DarkThemeStoryWrapper>
        <Story />
      </DarkThemeStoryWrapper>
    ),
  ],
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div>
      <Toaster />
      <button
        type="button"
        className="rounded-md border border-input bg-bg px-4 py-2 text-sm"
        onClick={() => toast("This is a toast notification")}
      >
        Show Toast
      </button>
    </div>
  ),
};

export const WithVariants: Story = {
  render: () => (
    <div className="flex gap-2">
      <Toaster />
      <button
        type="button"
        className="rounded-md border border-input bg-bg px-4 py-2 text-sm"
        onClick={() => toast.success("Success!")}
      >
        Success
      </button>
      <button
        type="button"
        className="rounded-md border border-input bg-bg px-4 py-2 text-sm"
        onClick={() => toast.error("Error!")}
      >
        Error
      </button>
      <button
        type="button"
        className="rounded-md border border-input bg-bg px-4 py-2 text-sm"
        onClick={() => toast.info("Info")}
      >
        Info
      </button>
    </div>
  ),
};
