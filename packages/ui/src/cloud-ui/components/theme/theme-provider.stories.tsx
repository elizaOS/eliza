import type { Meta, StoryObj } from "@storybook/react";
import { ThemeProvider } from "./theme-provider";
import { useTheme } from "./theme-provider.hooks";

function ThemeConsumer() {
  const { theme, setTheme, resolvedTheme, systemTheme } = useTheme();
  const cardStyle: React.CSSProperties = {
    padding: 24,
    borderRadius: 12,
    border: "1px solid rgba(127,127,127,0.3)",
    background: resolvedTheme === "dark" ? "#0b0b0c" : "#fafafa",
    color: resolvedTheme === "dark" ? "#fafafa" : "#0b0b0c",
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    width: 360,
  };
  const btnRow: React.CSSProperties = {
    display: "flex",
    gap: 8,
    marginTop: 12,
  };
  const btnStyle = (active: boolean): React.CSSProperties => ({
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid rgba(127,127,127,0.4)",
    background: active ? "#ff7a1a" : "transparent",
    color: active ? "#0b0b0c" : "inherit",
    cursor: "pointer",
    fontSize: 13,
  });

  return (
    <div style={cardStyle}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>Theme Provider</div>
      <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
        <div>
          theme: <code>{theme}</code>
        </div>
        <div>
          resolved: <code>{resolvedTheme}</code>
        </div>
        <div>
          system: <code>{systemTheme}</code>
        </div>
      </div>
      <div style={btnRow}>
        <button
          type="button"
          style={btnStyle(theme === "light")}
          onClick={() => setTheme("light")}
        >
          Light
        </button>
        <button
          type="button"
          style={btnStyle(theme === "dark")}
          onClick={() => setTheme("dark")}
        >
          Dark
        </button>
        <button
          type="button"
          style={btnStyle(theme === "system")}
          onClick={() => setTheme("system")}
        >
          System
        </button>
      </div>
    </div>
  );
}

const meta = {
  title: "CloudUI/Theme/ThemeProvider",
  component: ThemeProvider,
  tags: ["autodocs"],
  argTypes: {
    defaultTheme: {
      control: "select",
      options: ["light", "dark", "system"],
    },
    attribute: { control: "select", options: ["class", "data-theme"] },
    enableSystem: { control: "boolean" },
    disableTransitionOnChange: { control: "boolean" },
    storageKey: { control: "text" },
  },
  args: {
    defaultTheme: "system",
    attribute: "class",
    enableSystem: true,
    disableTransitionOnChange: false,
    storageKey: "eliza-cloud-theme-story",
    children: <ThemeConsumer />,
  },
} satisfies Meta<typeof ThemeProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SystemDefault: Story = {};

export const LightDefault: Story = {
  args: {
    defaultTheme: "light",
    storageKey: "eliza-cloud-theme-story-light",
  },
};

export const DarkDefault: Story = {
  args: {
    defaultTheme: "dark",
    storageKey: "eliza-cloud-theme-story-dark",
  },
};

export const SystemDisabled: Story = {
  args: {
    defaultTheme: "system",
    enableSystem: false,
    storageKey: "eliza-cloud-theme-story-nosys",
  },
};

export const DataThemeAttribute: Story = {
  args: {
    attribute: "data-theme",
    defaultTheme: "dark",
    disableTransitionOnChange: true,
    storageKey: "eliza-cloud-theme-story-attr",
  },
};
