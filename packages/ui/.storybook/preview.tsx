import { TooltipProvider } from "@elizaos/ui/components/ui/tooltip";
import { withThemeByClassName } from "@storybook/addon-themes";
import type { Preview } from "@storybook/react";
import type { ReactNode } from "react";
import { useEffect } from "react";

// The bundled UI stylesheets (tokens, base, brand) — the renderer entry, so the
// catalog looks exactly like the app.
import "@elizaos/ui/styles";
import "./preview.css";

const STORYBOOK_THEMES = new Set(["light", "dark"]);

function resolveStorybookTheme(theme: unknown): "light" | "dark" {
  return theme === "light" || theme === "dark" ? theme : "dark";
}

function StorybookThemeSurface({
  children,
  theme,
}: {
  children: ReactNode;
  theme: "light" | "dark";
}) {
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
    document.body.dataset.theme = theme;
  }, [theme]);

  return (
    <div
      className={
        theme === "dark"
          ? "storybook-theme-surface dark"
          : "storybook-theme-surface"
      }
      data-theme={theme}
    >
      {children}
    </div>
  );
}

const preview: Preview = {
  globalTypes: {
    theme: {
      toolbar: {
        icon: "circlehollow",
        items: [...STORYBOOK_THEMES],
        title: "Theme",
      },
    },
  },
  initialGlobals: {
    theme: "dark",
  },
  parameters: {
    controls: {
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
    layout: "centered",
    backgrounds: { disable: true }, // theme classes own the background
  },
  decorators: [
    (Story, context) => (
      <TooltipProvider delayDuration={200} skipDelayDuration={100}>
        <StorybookThemeSurface
          theme={resolveStorybookTheme(context.globals.theme)}
        >
          <Story />
        </StorybookThemeSurface>
      </TooltipProvider>
    ),
    // Light/dark by toggling the `dark` class on the preview root — matches how
    // the app themes (the design tokens key off it).
    withThemeByClassName({
      themes: { light: "", dark: "dark" },
      defaultTheme: "dark",
    }),
  ],
};

export default preview;
