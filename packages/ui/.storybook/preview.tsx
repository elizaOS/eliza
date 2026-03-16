import type { Preview } from "@storybook/react";
import type React from "react";
import "./storybook.css";

const ThemeDecorator = (
  Story: React.ComponentType,
  context: { globals: { theme?: string } },
) => {
  const theme = context.globals.theme || "dark";
  return (
    <div
      className={theme === "dark" ? "dark" : ""}
      data-theme={theme}
      style={{ minHeight: "100vh" }}
    >
      <div style={{ padding: "2rem" }}>
        <Story />
      </div>
    </div>
  );
};

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Light/Dark theme for components",
      toolbar: {
        title: "Theme",
        icon: "sun",
        items: [
          { value: "light", title: "☀ Light", icon: "sun" },
          { value: "dark", title: "🌙 Dark", icon: "moon" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: "dark",
  },
  decorators: [ThemeDecorator],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      disable: true,
    },
    layout: "fullscreen",
  },
};

export default preview;
